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
exports.SpoolTailer = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const events_1 = require("events");
const core_1 = require("@codepulse/core");
const protocol_1 = require("@codepulse/protocol");
const NEWLINE_BYTE = 0x0a;
/**
 * Per-poll read cap so a large unread spool (first start, cursor loss,
 * inode reset) is consumed in chunks across polls instead of one
 * multi-hundred-MB Buffer.alloc. Sized one byte over the protocol's max
 * frame (256 KiB) so a maximal valid line plus its newline always fits in a
 * single capped read — a FULL chunk with no newline therefore proves the
 * line is oversized, not merely a writer mid-append.
 *
 * NOTE: the spool is append-only and never compacted here — hook wrappers
 * (hooks/forward.sh) append to it from outside the daemon process, so
 * truncating it from this process would race external writers.
 */
const MAX_READ_BYTES_PER_POLL = 256 * 1024 + 1;
class SpoolTailer extends events_1.EventEmitter {
    options;
    metrics;
    watcher = null;
    pollTimer = null;
    offset = 0;
    spoolInode;
    running = false;
    isReading = false;
    pollIntervalMs;
    constructor(options, metrics) {
        super();
        this.options = options;
        this.metrics = metrics;
        this.pollIntervalMs = options.pollIntervalMs ?? 250;
    }
    async start() {
        if (this.running) {
            return;
        }
        this.running = true;
        (0, core_1.ensureDir)(path.dirname(this.options.spoolPath));
        this.loadCursor();
        await this.readNewData();
        this.watcher = fs.watch(path.dirname(this.options.spoolPath), (_event, filename) => {
            if (!filename || filename === path.basename(this.options.spoolPath)) {
                void this.readNewData().catch(error => this.emit('error', error));
            }
        });
        this.pollTimer = setInterval(() => {
            void this.readNewData().catch(error => this.emit('error', error));
        }, this.pollIntervalMs);
    }
    async stop() {
        this.running = false;
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.saveCursor();
    }
    getOffset() {
        return this.offset;
    }
    getSpoolPath() {
        return this.options.spoolPath;
    }
    loadCursor() {
        try {
            const raw = fs.readFileSync(this.options.cursorPath, 'utf8');
            const cursor = JSON.parse(raw);
            this.offset = cursor.offset ?? 0;
            this.spoolInode = cursor.inode;
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                this.emit('error', error);
            }
            this.offset = 0;
            this.spoolInode = undefined;
        }
    }
    saveCursor() {
        const cursor = {
            offset: this.offset,
            inode: this.spoolInode,
            updatedAt: new Date().toISOString()
        };
        (0, core_1.ensureDir)(path.dirname(this.options.cursorPath));
        fs.writeFileSync(this.options.cursorPath, JSON.stringify(cursor, null, 2));
    }
    async readNewData() {
        if (!this.running || this.isReading) {
            return;
        }
        this.isReading = true;
        let handle;
        try {
            handle = await fs.promises.open(this.options.spoolPath, 'r');
            const stats = await handle.stat();
            const inode = `${stats.ino}`;
            if (this.spoolInode && this.spoolInode !== inode) {
                this.offset = 0;
            }
            this.spoolInode = inode;
            if (stats.size < this.offset) {
                this.offset = 0;
            }
            if (stats.size === this.offset) {
                this.saveCursor();
                return;
            }
            const length = Math.min(stats.size - this.offset, MAX_READ_BYTES_PER_POLL);
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
            if (bytesRead <= 0) {
                return;
            }
            // Only consume up to the last raw newline byte. The trailing
            // partial line is never buffered in memory — the cursor stays at
            // the line start so the partial is naturally re-read exactly once
            // when the writer completes it (no double-prepend corruption).
            // Bytes past the cap are picked up by subsequent polls.
            const data = buffer.subarray(0, bytesRead);
            const lastNewline = data.lastIndexOf(NEWLINE_BYTE);
            if (lastNewline === -1) {
                if (bytesRead >= MAX_READ_BYTES_PER_POLL) {
                    // A full capped chunk with no newline means the line
                    // already exceeds the max frame size (it could never
                    // validate) — skip its bytes so one garbage line cannot
                    // stall the tailer forever. The eventual tail past the
                    // newline fails JSON.parse and drops like any bad line.
                    this.metrics.increment('codepulse_spool_lines_dropped_total');
                    this.offset += bytesRead;
                }
                this.saveCursor();
                return;
            }
            await this.processLines(data.subarray(0, lastNewline + 1).toString('utf8'));
            this.offset += lastNewline + 1;
            this.saveCursor();
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return;
            }
            throw error;
        }
        finally {
            this.isReading = false;
            await handle?.close();
        }
    }
    async processLines(text) {
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            const frameResult = (0, protocol_1.validateFrameSize)(Buffer.byteLength(trimmed, 'utf8'));
            if (!frameResult.ok) {
                this.metrics.increment('codepulse_spool_lines_dropped_total');
                continue;
            }
            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            }
            catch {
                this.metrics.increment('codepulse_spool_lines_dropped_total');
                continue;
            }
            const result = (0, protocol_1.validateEnvelope)(parsed);
            if (!result.ok) {
                this.metrics.increment('codepulse_spool_lines_dropped_total');
                continue;
            }
            this.metrics.increment('codepulse_spool_lines_read_total');
            if (this.options.database) {
                const ingested = await this.options.database.ingestEnvelopeFromSpool(result.value);
                if (ingested) {
                    this.metrics.increment('codepulse_spool_envelopes_ingested_total');
                }
            }
            this.emit('envelope', result.value);
        }
    }
}
exports.SpoolTailer = SpoolTailer;
//# sourceMappingURL=tailer.js.map