import * as fs from 'fs';
import { EventEmitter } from 'events';
import type { DatabaseV5 } from '@codepulse/core';
import type { RegistryHost, ScannerManifest, ParsedLogEvent } from '@codepulse/registry';
import type { MetricsRegistry } from '../metrics';
import { expandLogGlobAsync } from './glob';

const MAX_READ_BYTES_PER_POLL = 256 * 1024;
const MAX_PARTIAL_LINE_BYTES = 1024 * 1024;
const NEWLINE_BYTE = 0x0a;
const EMPTY_BUFFER = Buffer.alloc(0);

export interface LogTailerOptions {
    pollIntervalMs?: number;
    maxReadBytesPerPoll?: number;
}

export interface LogTailerDeps {
    registryHost: RegistryHost;
    database: DatabaseV5;
    metrics: MetricsRegistry;
    isEnabled: (manifest: ScannerManifest) => boolean;
}

/**
 * A parsed event plus the absolute byte offset where its line starts in the
 * file — the offset discriminates byte-identical lines at different
 * positions when deriving deterministic envelope ids, while replays of the
 * same physical line keep the same offset and still dedup.
 */
export type TailedLogEvent = ParsedLogEvent & { byteOffset: number };

export type LogTailBatch = {
    manifest: ScannerManifest;
    filePath: string;
    parserId: string;
    logGlob: string;
    events: TailedLogEvent[];
    /**
     * Tail-state generation this batch was read under. `resetState` bumps
     * the file's generation, so any batch still queued or in flight when an
     * ingest fails becomes stale — the engine drops it instead of letting
     * its cursor advance past the rolled-back lines.
     */
    generation: number;
    cursor: {
        scanner_id: string;
        log_glob: string;
        byte_offset: number;
        inode: string;
        last_event_id: string | null;
    };
};

/**
 * In-memory authoritative tail position for one (scanner, file) pair.
 *
 * `committedOffset` only ever points at the start of the first incomplete
 * line — the persisted cursor mirrors it, so a daemon restart re-reads (and
 * dedups, via deterministic envelope ids) instead of losing the in-flight
 * line. `pending` carries the raw unterminated bytes forward so the same
 * bytes are never re-parsed within a session, and all offset arithmetic
 * stays in raw bytes (decoded-string byte math corrupts offsets when a
 * multi-byte UTF-8 char straddles a read boundary).
 */
interface FileTailState {
    inode: string;
    committedOffset: number;
    pending: Buffer;
    lastEventId: string | null;
    /** Generation this state was created under; stamped onto every batch. */
    generation: number;
}

export class LogTailer extends EventEmitter {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private isPolling = false;
    private readonly tailStates = new Map<string, FileTailState>();
    /** Survives `tailStates` deletions so stale batches stay identifiable. */
    private readonly tailGenerations = new Map<string, number>();
    private readonly pollIntervalMs: number;
    private readonly maxReadBytesPerPoll: number;

    constructor(
        private readonly deps: LogTailerDeps,
        options: LogTailerOptions = {}
    ) {
        super();
        this.pollIntervalMs = options.pollIntervalMs ?? 3000;
        this.maxReadBytesPerPoll = options.maxReadBytesPerPoll ?? MAX_READ_BYTES_PER_POLL;
    }

    async start(manifests: ScannerManifest[]): Promise<void> {
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

    async stop(): Promise<void> {
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
    resetState(scannerId: string, filePath: string): void {
        const stateKey = this.tailStateKey(scannerId, filePath);
        this.tailGenerations.set(stateKey, this.currentGeneration(stateKey) + 1);
        this.tailStates.delete(stateKey);
    }

    /**
     * False when `resetState` ran for the batch's file after the batch was
     * read — committing such a batch's cursor would skip the rolled-back
     * lines forever, so the engine must drop it.
     */
    isCurrentGeneration(batch: LogTailBatch): boolean {
        const stateKey = this.tailStateKey(batch.manifest.id, batch.filePath);
        return batch.generation === this.currentGeneration(stateKey);
    }

    private currentGeneration(stateKey: string): number {
        return this.tailGenerations.get(stateKey) ?? 0;
    }

    /** NUL separator — it can appear in neither scanner ids nor file paths. */
    private tailStateKey(scannerId: string, filePath: string): string {
        return `${scannerId}\u0000${filePath}`;
    }

    private async poll(manifests: ScannerManifest[]): Promise<void> {
        if (this.isPolling) {
            return;
        }
        this.isPolling = true;
        try {
            await this.pollManifests(manifests);
        } finally {
            this.isPolling = false;
        }
    }

    private async pollManifests(manifests: ScannerManifest[]): Promise<void> {
        for (const manifest of manifests) {
            if (!this.deps.isEnabled(manifest)) {
                continue;
            }
            if (!manifest.capabilities.includes('log') || !manifest.logPaths?.length) {
                continue;
            }

            for (const logPath of manifest.logPaths) {
                const files = await expandLogGlobAsync(logPath.glob, undefined, dropped => {
                    this.deps.metrics.increment(
                        'codepulse_scanner_log_glob_truncated_total',
                        dropped
                    );
                });
                for (const filePath of files) {
                    try {
                        await this.tailFile(manifest, logPath.parser, logPath.glob, filePath);
                    } catch (error) {
                        // One unreadable file (EACCES/EMFILE/…) must not stall
                        // every file ordered after it.
                        this.deps.metrics.increment('codepulse_scanner_log_tail_errors_total');
                        this.emit(
                            'error',
                            error instanceof Error ? error : new Error(String(error))
                        );
                    }
                    await yieldEventLoop();
                }
            }
        }
    }

    private async tailFile(
        manifest: ScannerManifest,
        parserId: string,
        logGlob: string,
        filePath: string
    ): Promise<void> {
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(filePath);
        } catch {
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
            const combined =
                state.pending.length > 0 ? Buffer.concat([state.pending, chunk]) : chunk;
            const lastNewline = combined.lastIndexOf(NEWLINE_BYTE);

            if (lastNewline === -1) {
                if (combined.length > MAX_PARTIAL_LINE_BYTES) {
                    // Oversized unterminated line — drop it and legitimately
                    // advance the cursor past the dropped bytes.
                    this.deps.metrics.increment('codepulse_scanner_log_line_truncated_total');
                    state.pending = EMPTY_BUFFER;
                    state.committedOffset = readOffset + bytesRead;
                    this.emitBatch(manifest, parserId, logGlob, filePath, [], state);
                } else {
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
        } finally {
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
    private async parseLines(
        parserId: string,
        completeBytes: Buffer,
        baseOffset: number
    ): Promise<TailedLogEvent[]> {
        const events: TailedLogEvent[] = [];
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
                const event = await this.deps.registryHost.parseLogLine(
                    parserId,
                    lineBytes.toString('utf8'),
                    { useSandbox: false }
                );
                if (event) {
                    events.push({ ...event, byteOffset });
                }
            } catch {
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
    private async resolveTailState(
        scannerId: string,
        filePath: string,
        inode: string,
        fileSize: number
    ): Promise<FileTailState> {
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

    private emitBatch(
        manifest: ScannerManifest,
        parserId: string,
        logGlob: string,
        filePath: string,
        events: TailedLogEvent[],
        state: FileTailState
    ): void {
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
        } satisfies LogTailBatch);
    }
}

export type ParsedLogPayload = {
    manifest: ScannerManifest;
    filePath: string;
    event: ParsedLogEvent;
};

function yieldEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}
