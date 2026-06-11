"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogTailer = void 0;
const fs = __importStar(require("fs"));
const events_1 = require("events");
const glob_1 = require("./glob");
const MAX_READ_BYTES_PER_POLL = 256 * 1024;
const MAX_PARTIAL_LINE_BYTES = 1024 * 1024;
const NEWLINE_BYTE = 0x0a;
const EMPTY_BUFFER = Buffer.alloc(0);
class LogTailer extends events_1.EventEmitter {
    deps;
    timer = null;
    running = false;
    isPolling = false;
    tailStates = new Map();
    /** Survives `tailStates` deletions so stale batches stay identifiable. */
    tailGenerations = new Map();
    pollIntervalMs;
    maxReadBytesPerPoll;
    constructor(deps, options = {}) {
        super();
        this.deps = deps;
        this.pollIntervalMs = options.pollIntervalMs ?? 3000;
        this.maxReadBytesPerPoll = options.maxReadBytesPerPoll ?? MAX_READ_BYTES_PER_POLL;
    }
    async start(manifests) {
        if (this.running) {
            return;
        }
        this.running = true;
        setImmediate(() => {
            void this.poll(manifests).catch(error => this.emit('error', error));
        });
        this.timer = setInterval(() => {
            void this.poll(manifests).catch(error => {
                this.emit('error', error);
            });
        }, this.pollIntervalMs);
    }
    async stop() {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /**
     * Drops the in-memory tail state for one (scanner, file) pair so the
     * next poll resumes from the last PERSISTED cursor. Called by the engine
     * when a batch's durable ingest fails — the in-memory offset had already
     * advanced past the failed lines, so without this reset they would never
     * be re-read. The replayed prefix dedups via deterministic envelope ids.
     *
     * Bumping the generation marks every batch read under the dropped state
     * — including ones already queued behind the failing ingest or still in
     * flight inside `tailFile` — as stale, so only the post-reset replay can
     * advance the persisted cursor.
     */
    resetState(scannerId, filePath) {
        const stateKey = this.tailStateKey(scannerId, filePath);
        this.tailGenerations.set(stateKey, this.currentGeneration(stateKey) + 1);
        this.tailStates.delete(stateKey);
    }
    /**
     * False when `resetState` ran for the batch's file after the batch was
     * read — committing such a batch's cursor would skip the rolled-back
     * lines forever, so the engine must drop it.
     */
    isCurrentGeneration(batch) {
        const stateKey = this.tailStateKey(batch.manifest.id, batch.filePath);
        return batch.generation === this.currentGeneration(stateKey);
    }
    currentGeneration(stateKey) {
        return this.tailGenerations.get(stateKey) ?? 0;
    }
    /** NUL separator — it can appear in neither scanner ids nor file paths. */
    tailStateKey(scannerId, filePath) {
        return `${scannerId}\u0000${filePath}`;
    }
    async poll(manifests) {
        if (this.isPolling) {
            return;
        }
        this.isPolling = true;
        try {
            await this.pollManifests(manifests);
        }
        finally {
            this.isPolling = false;
        }
    }
    async pollManifests(manifests) {
        for (const manifest of manifests) {
            if (!this.deps.isEnabled(manifest)) {
                continue;
            }
            if (!manifest.capabilities.includes('log') || !manifest.logPaths?.length) {
                continue;
            }
            for (const logPath of manifest.logPaths) {
                const files = await (0, glob_1.expandLogGlobAsync)(logPath.glob, undefined, dropped => {
                    this.deps.metrics.increment('codepulse_scanner_log_glob_truncated_total', dropped);
                });
                for (const filePath of files) {
                    try {
                        await this.tailFile(manifest, logPath.parser, logPath.glob, filePath);
                    }
                    catch (error) {
                        // One unreadable file (EACCES/EMFILE/…) must not stall
                        // every file ordered after it.
                        this.deps.metrics.increment('codepulse_scanner_log_tail_errors_total');
                        this.emit('error', error instanceof Error ? error : new Error(String(error)));
                    }
                    await yieldEventLoop();
                }
            }
        }
    }
    async tailFile(manifest, parserId, logGlob, filePath) {
        let stat;
        try {
            stat = await fs.promises.stat(filePath);
        }
        catch {
            return;
        }
        if (!stat.isFile()) {
            return;
        }
        const inode = `${stat.ino}`;
        const stateKey = this.tailStateKey(manifest.id, filePath);
        const state = await this.resolveTailState(manifest.id, filePath, inode, stat.size);
        const readOffset = state.committedOffset + state.pending.length;
        if (stat.size === readOffset) {
            return;
        }
        const handle = await fs.promises.open(filePath, 'r');
        try {
            const length = Math.min(stat.size - readOffset, this.maxReadBytesPerPoll);
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, readOffset);
            if (this.tailStates.get(stateKey) !== state) {
                // resetState replaced/dropped this state mid-read — mutating
                // or emitting from the orphaned reference would advance the
                // cursor past the failed lines the reset is replaying.
                return;
            }
            if (bytesRead <= 0) {
                return;
            }
            const chunk = buffer.subarray(0, bytesRead);
            const combined = state.pending.length > 0 ? Buffer.concat([state.pending, chunk]) : chunk;
            const lastNewline = combined.lastIndexOf(NEWLINE_BYTE);
            if (lastNewline === -1) {
                if (combined.length > MAX_PARTIAL_LINE_BYTES) {
                    // Oversized unterminated line — drop it and legitimately
                    // advance the cursor past the dropped bytes.
                    this.deps.metrics.increment('codepulse_scanner_log_line_truncated_total');
                    state.pending = EMPTY_BUFFER;
                    state.committedOffset = readOffset + bytesRead;
                    this.emitBatch(manifest, parserId, logGlob, filePath, [], state);
                }
                else {
                    // Keep the raw bytes in memory; the persisted cursor stays
                    // at the start of the incomplete line.
                    state.pending = combined;
                }
                return;
            }
            const completeBytes = combined.subarray(0, lastNewline + 1);
            const remainder = combined.subarray(lastNewline + 1);
            // `combined` byte 0 sits at the pre-advance committed offset, so
            // each line's absolute start offset is baseOffset + its index.
            const baseOffset = state.committedOffset;
            state.pending = remainder.length > 0 ? Buffer.from(remainder) : EMPTY_BUFFER;
            state.committedOffset += lastNewline + 1;
            const events = await this.parseLines(parserId, completeBytes, baseOffset);
            if (this.tailStates.get(stateKey) !== state) {
                // resetState fired while parsing — abandon the batch; the
                // next poll re-reads these lines from the persisted cursor.
                return;
            }
            if (events.length > 0) {
                this.deps.metrics.increment('codepulse_scanner_log_events_total', events.length);
                state.lastEventId = events.at(-1)?.lineHash ?? state.lastEventId;
            }
            this.emitBatch(manifest, parserId, logGlob, filePath, events, state);
        }
        finally {
            await handle.close();
        }
    }
    /**
     * Per-line parse isolation: one throwing line is dropped (and counted)
     * while the rest of the chunk continues, regardless of which registered
     * parser is in use. Lines are split on raw newline BYTES so each line's
     * absolute start offset stays exact even when earlier lines contain
     * multi-byte UTF-8 characters.
     */
    async parseLines(parserId, completeBytes, baseOffset) {
        const events = [];
        let lineStart = 0;
        while (lineStart < completeBytes.length) {
            // `completeBytes` always ends with a newline, so this never -1s.
            const newlineIndex = completeBytes.indexOf(NEWLINE_BYTE, lineStart);
            const lineBytes = completeBytes.subarray(lineStart, newlineIndex);
            const byteOffset = baseOffset + lineStart;
            lineStart = newlineIndex + 1;
            if (lineBytes.length === 0) {
                continue;
            }
            try {
                const event = await this.deps.registryHost.parseLogLine(parserId, lineBytes.toString('utf8'), { useSandbox: false });
                if (event) {
                    events.push({ ...event, byteOffset });
                }
            }
            catch {
                this.deps.metrics.increment('codepulse_scanner_log_parse_errors_total');
            }
        }
        return events;
    }
    /**
     * The in-memory state is authoritative mid-session — the persisted cursor
     * row is only consulted when no state exists yet (fresh start, or after
     * `resetState` dropped it on a failed ingest), so a DB row that lags an
     * in-flight batch ingest is never re-read.
     */
    async resolveTailState(scannerId, filePath, inode, fileSize) {
        const stateKey = this.tailStateKey(scannerId, filePath);
        let state = this.tailStates.get(stateKey);
        if (!state) {
            const cursor = await this.deps.database.getParserCursor(scannerId, filePath);
            state = {
                inode: cursor?.inode ?? inode,
                committedOffset: cursor?.byte_offset ?? 0,
                pending: EMPTY_BUFFER,
                lastEventId: cursor?.last_event_id ?? null,
                // Read AFTER the cursor await so a reset that fired while we
                // were reading the DB still stamps this state as current.
                generation: this.currentGeneration(stateKey)
            };
            this.tailStates.set(stateKey, state);
        }
        if (state.inode !== inode) {
            state.inode = inode;
            state.committedOffset = 0;
            state.pending = EMPTY_BUFFER;
            state.lastEventId = null;
        }
        if (fileSize < state.committedOffset + state.pending.length) {
            state.committedOffset = 0;
            state.pending = EMPTY_BUFFER;
        }
        return state;
    }
    emitBatch(manifest, parserId, logGlob, filePath, events, state) {
        this.emit('batch', {
            manifest,
            filePath,
            parserId,
            logGlob,
            events,
            generation: state.generation,
            cursor: {
                scanner_id: manifest.id,
                log_glob: filePath,
                byte_offset: state.committedOffset,
                inode: state.inode,
                last_event_id: state.lastEventId
            }
        });
    }
}
exports.LogTailer = LogTailer;
function yieldEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}
//# sourceMappingURL=log-tailer.js.map