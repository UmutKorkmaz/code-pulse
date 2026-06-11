import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { type DatabaseV5, ensureDir } from '@codepulse/core';
import { validateEnvelope, validateFrameSize, type AnyEnvelope } from '@codepulse/protocol';
import type { MetricsRegistry } from '../metrics';

interface SpoolCursor {
    offset: number;
    inode?: string;
    updatedAt: string;
}

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

export interface SpoolTailerOptions {
    spoolPath: string;
    cursorPath: string;
    pollIntervalMs?: number;
    database?: DatabaseV5;
}

export declare interface SpoolTailer {
    on(event: 'envelope', listener: (envelope: AnyEnvelope) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
}

export class SpoolTailer extends EventEmitter {
    private watcher: fs.FSWatcher | null = null;
    private pollTimer: NodeJS.Timeout | null = null;
    private offset = 0;
    private spoolInode: string | undefined;
    private running = false;
    private isReading = false;
    private readonly pollIntervalMs: number;

    constructor(
        private readonly options: SpoolTailerOptions,
        private readonly metrics: MetricsRegistry
    ) {
        super();
        this.pollIntervalMs = options.pollIntervalMs ?? 250;
    }

    async start(): Promise<void> {
        if (this.running) {
            return;
        }

        this.running = true;
        ensureDir(path.dirname(this.options.spoolPath));
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

    async stop(): Promise<void> {
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

    getOffset(): number {
        return this.offset;
    }

    getSpoolPath(): string {
        return this.options.spoolPath;
    }

    private loadCursor(): void {
        try {
            const raw = fs.readFileSync(this.options.cursorPath, 'utf8');
            const cursor = JSON.parse(raw) as SpoolCursor;
            this.offset = cursor.offset ?? 0;
            this.spoolInode = cursor.inode;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.emit('error', error as Error);
            }
            this.offset = 0;
            this.spoolInode = undefined;
        }
    }

    private saveCursor(): void {
        const cursor: SpoolCursor = {
            offset: this.offset,
            inode: this.spoolInode,
            updatedAt: new Date().toISOString()
        };

        ensureDir(path.dirname(this.options.cursorPath));
        fs.writeFileSync(this.options.cursorPath, JSON.stringify(cursor, null, 2));
    }

    private async readNewData(): Promise<void> {
        if (!this.running || this.isReading) {
            return;
        }

        this.isReading = true;
        let handle: fs.promises.FileHandle | undefined;
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
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return;
            }
            throw error;
        } finally {
            this.isReading = false;
            await handle?.close();
        }
    }

    private async processLines(text: string): Promise<void> {
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }

            const frameResult = validateFrameSize(Buffer.byteLength(trimmed, 'utf8'));
            if (!frameResult.ok) {
                this.metrics.increment('codepulse_spool_lines_dropped_total');
                continue;
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(trimmed);
            } catch {
                this.metrics.increment('codepulse_spool_lines_dropped_total');
                continue;
            }

            const result = validateEnvelope(parsed);
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