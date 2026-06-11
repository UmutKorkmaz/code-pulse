import assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

// Compiled daemon scanner modules — import via relative path to dist for tests
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LogTailer } = require('../../../apps/daemon/dist/scanner/log-tailer.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deriveEnvelopeId } = require('../../../apps/daemon/dist/envelope.js');

interface BatchCursor {
    scanner_id: string;
    log_glob: string;
    byte_offset: number;
    inode: string;
    last_event_id: string | null;
}

interface Batch {
    filePath: string;
    events: Array<{ lineHash: string; byteOffset: number; metadata: { line: string } }>;
    generation: number;
    cursor: BatchCursor;
}

function sha256(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function buildManifest(id: string, glob: string) {
    return {
        id,
        version: '1.0.0',
        displayName: 'Test Scanner',
        publisher: 'test',
        trust: 'official',
        minDaemon: '0.1.0',
        minProtocol: '5.1',
        capabilities: ['log'],
        logPaths: [{ glob, parser: 'test-parser', watchMode: 'tail' }],
        contentPolicy: 'metadata-only',
        signature: 'sig',
        bundleHash: 'hash'
    };
}

/**
 * Test harness around one LogTailer instance: a stub registry parser that
 * echoes each raw line (lineHash = sha256(line)), a stub cursor store that
 * mimics the engine persisting batch.cursor after each ingest, and a batch
 * collector. `restart()` returns a fresh tailer wired to the SAME cursor
 * store, simulating a daemon restart resuming from the persisted cursor.
 */
function createHarness(options: { maxReadBytesPerPoll?: number } = {}) {
    const cursorStore = new Map<string, BatchCursor>();
    const errors: Error[] = [];

    const makeTailer = () => {
        const batches: Batch[] = [];
        let persistCursors = true;
        let parseHook: ((line: string) => void) | null = null;
        const tailer = new LogTailer(
            {
                registryHost: {
                    parseLogLine: async (_parserId: string, line: string) => {
                        parseHook?.(line);
                        return {
                            parserId: 'test-parser',
                            lineHash: sha256(line),
                            timestamp: new Date(0).toISOString(),
                            eventType: 'line',
                            metadata: { line }
                        };
                    }
                },
                database: {
                    getParserCursor: async (scannerId: string, logGlob: string) =>
                        cursorStore.get(`${scannerId} ${logGlob}`) ?? null
                },
                metrics: { increment: () => undefined },
                isEnabled: () => true
            },
            options
        );
        tailer.on('error', (error: Error) => errors.push(error));
        tailer.on('batch', (batch: Batch) => {
            batches.push(batch);
            if (persistCursors) {
                cursorStore.set(
                    `${batch.cursor.scanner_id} ${batch.cursor.log_glob}`,
                    batch.cursor
                );
            }
        });
        return {
            tailer,
            batches,
            poll: async (manifests: unknown[]) => {
                await tailer.poll(manifests);
            },
            stopPersistingCursors: () => {
                persistCursors = false;
            },
            resumePersistingCursors: () => {
                persistCursors = true;
            },
            setParseHook: (hook: ((line: string) => void) | null) => {
                parseHook = hook;
            }
        };
    };

    return { makeTailer, cursorStore, errors };
}

function eventLines(batches: Batch[]): string[] {
    return batches.flatMap(batch => batch.events.map(event => event.metadata.line));
}

describe('scanner log tailer cursor logic', () => {
    let tempDir = '';
    let logFile = '';
    let manifest: ReturnType<typeof buildManifest>;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-tailer-'));
        logFile = nodePath.join(tempDir, 'session.jsonl');
        manifest = buildManifest('scn.test', logFile);
    });

    afterEach(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('advances byte_offset exactly across appends between polls', async () => {
        // Arrange
        const harness = createHarness();
        const { batches, poll } = harness.makeTailer();
        fs.writeFileSync(logFile, 'alpha\n');

        // Act
        await poll([manifest]);
        fs.appendFileSync(logFile, 'beta\n');
        await poll([manifest]);

        // Assert
        assert.deepStrictEqual(harness.errors, []);
        assert.strictEqual(batches.length, 2);
        assert.deepStrictEqual(eventLines([batches[0]]), ['alpha']);
        assert.strictEqual(batches[0].cursor.byte_offset, 6);
        assert.deepStrictEqual(eventLines([batches[1]]), ['beta']);
        assert.strictEqual(batches[1].cursor.byte_offset, 11);
        assert.strictEqual(batches[1].cursor.last_event_id, sha256('beta'));
    });

    it('holds the cursor at the start of a line that spans two polls', async () => {
        // Arrange
        const harness = createHarness();
        const { batches, poll } = harness.makeTailer();
        fs.writeFileSync(logFile, 'first\npart');

        // Act
        await poll([manifest]);
        fs.appendFileSync(logFile, 'ial\n');
        await poll([manifest]);

        // Assert
        assert.deepStrictEqual(harness.errors, []);
        assert.deepStrictEqual(eventLines(batches), ['first', 'partial']);
        // Cursor never moved past the unterminated "part" prefix.
        assert.strictEqual(batches[0].cursor.byte_offset, 6);
        assert.strictEqual(batches[1].cursor.byte_offset, 14);
    });

    it('reassembles a multi-byte UTF-8 char split across the read boundary', async () => {
        // Arrange: 'aé✓\n' is 7 bytes (61 C3A9 E29C93 0A); a 4-byte read cap
        // splits the 3-byte '✓' between two polls.
        const harness = createHarness({ maxReadBytesPerPoll: 4 });
        const { batches, poll } = harness.makeTailer();
        fs.writeFileSync(logFile, 'aé✓\n');

        // Act
        await poll([manifest]);
        const batchesAfterFirstPoll = batches.length;
        await poll([manifest]);

        // Assert
        assert.deepStrictEqual(harness.errors, []);
        assert.strictEqual(batchesAfterFirstPoll, 0);
        assert.strictEqual(batches.length, 1);
        assert.deepStrictEqual(eventLines(batches), ['aé✓']);
        assert.ok(!batches[0].events[0].metadata.line.includes('�'));
        assert.strictEqual(batches[0].cursor.byte_offset, 7);
    });

    it('resets to offset zero when the file is truncated and rewritten', async () => {
        // Arrange
        const harness = createHarness();
        const { batches, poll } = harness.makeTailer();
        fs.writeFileSync(logFile, 'line1\nline2\n');

        // Act
        await poll([manifest]);
        fs.writeFileSync(logFile, 'new\n');
        await poll([manifest]);

        // Assert
        assert.deepStrictEqual(harness.errors, []);
        assert.strictEqual(batches[0].cursor.byte_offset, 12);
        assert.deepStrictEqual(eventLines([batches[1]]), ['new']);
        assert.strictEqual(batches[1].cursor.byte_offset, 4);
    });

    it('restarts from offset zero when the file is rotated to a new inode', async () => {
        // Arrange
        const harness = createHarness();
        const { batches, poll } = harness.makeTailer();
        fs.writeFileSync(logFile, 'one\n');
        await poll([manifest]);
        const oldInode = batches[0].cursor.inode;

        // Both files exist simultaneously, so the replacement is guaranteed a
        // different inode before it is renamed over the original.
        const replacement = nodePath.join(tempDir, 'session.jsonl.new');
        fs.writeFileSync(replacement, 'rotated\n');
        const newInode = `${fs.statSync(replacement).ino}`;
        assert.notStrictEqual(newInode, oldInode);

        // Act
        fs.renameSync(replacement, logFile);
        await poll([manifest]);

        // Assert
        assert.deepStrictEqual(harness.errors, []);
        assert.deepStrictEqual(eventLines([batches[1]]), ['rotated']);
        assert.strictEqual(batches[1].cursor.byte_offset, 8);
        assert.strictEqual(batches[1].cursor.inode, newInode);
    });

    it('loses and duplicates nothing across a restart with a pending partial line', async () => {
        // Arrange: first tailer commits past two full lines while "par" is
        // still pending in memory only.
        const harness = createHarness();
        const first = harness.makeTailer();
        fs.writeFileSync(logFile, 'first\nsecond\npar');
        await first.poll([manifest]);
        assert.deepStrictEqual(eventLines(first.batches), ['first', 'second']);
        assert.strictEqual(first.batches[0].cursor.byte_offset, 13);

        // Act: restart — a fresh tailer resumes from the persisted cursor and
        // the rest of the partial line arrives afterwards.
        const second = harness.makeTailer();
        fs.appendFileSync(logFile, 'tial\nthird\n');
        await second.poll([manifest]);

        // Assert: every line seen exactly once across both instances.
        const allLines = [...eventLines(first.batches), ...eventLines(second.batches)];
        assert.deepStrictEqual(allLines, ['first', 'second', 'partial', 'third']);
        assert.strictEqual(new Set(allLines).size, allLines.length);
        assert.strictEqual(second.batches.at(-1)?.cursor.byte_offset, 27);
    });

    it('replays a line with an identical deterministic envelope id when the cursor lags', async () => {
        // Arrange: persist the cursor for the first batch only, then simulate
        // a crash before the second batch's cursor write.
        const harness = createHarness();
        const first = harness.makeTailer();
        fs.writeFileSync(logFile, 'first\n');
        await first.poll([manifest]);
        first.stopPersistingCursors();
        fs.appendFileSync(logFile, 'second\n');
        await first.poll([manifest]);

        // Act: restart re-reads from the stale cursor and re-parses "second".
        const second = harness.makeTailer();
        await second.poll([manifest]);

        // Assert: the replayed line is byte-identical AND starts at the same
        // byte offset, so its derived envelope id matches the original and
        // SQLite dedup discards the replay.
        const original = first.batches[1].events[0];
        const replayed = second.batches[0].events[0];
        assert.strictEqual(replayed.metadata.line, 'second');
        assert.strictEqual(replayed.lineHash, original.lineHash);
        assert.strictEqual(replayed.byteOffset, original.byteOffset);
        const originalId = deriveEnvelopeId(
            manifest.id,
            logFile,
            String(original.byteOffset),
            original.lineHash,
            'ai.tokens'
        );
        const replayedId = deriveEnvelopeId(
            manifest.id,
            logFile,
            String(replayed.byteOffset),
            replayed.lineHash,
            'ai.tokens'
        );
        assert.strictEqual(replayedId, originalId);

        // Distinct physical lines still derive distinct envelope ids.
        const firstEvent = first.batches[0].events[0];
        const firstLineId = deriveEnvelopeId(
            manifest.id,
            logFile,
            String(firstEvent.byteOffset),
            firstEvent.lineHash,
            'ai.tokens'
        );
        assert.notStrictEqual(firstLineId, originalId);
    });

    it('derives distinct envelope ids for byte-identical lines at different offsets', async () => {
        // Arrange: two identical NDJSON lines — same content hash, different
        // physical positions in the file.
        const harness = createHarness();
        const { batches, poll } = harness.makeTailer();
        fs.writeFileSync(logFile, 'dup\ndup\n');

        // Act
        await poll([manifest]);

        // Assert: same lineHash, distinct byte offsets => distinct ids, so
        // the second line's tokens are not swallowed by INSERT OR IGNORE.
        assert.deepStrictEqual(harness.errors, []);
        const events = batches.flatMap(batch => batch.events);
        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[0].lineHash, events[1].lineHash);
        assert.strictEqual(events[0].byteOffset, 0);
        assert.strictEqual(events[1].byteOffset, 4);
        const ids = events.map(event =>
            deriveEnvelopeId(manifest.id, logFile, String(event.byteOffset), event.lineHash, 'ai.tokens')
        );
        assert.notStrictEqual(ids[0], ids[1]);
    });

    it('keeps byte offsets exact when earlier lines contain multi-byte UTF-8', async () => {
        // Arrange: 'é✓\n' is 6 bytes but 3 string chars — offsets must come
        // from raw byte arithmetic, not decoded-string indices.
        const harness = createHarness();
        const { batches, poll } = harness.makeTailer();
        fs.writeFileSync(logFile, 'é✓\nplain\n');

        // Act
        await poll([manifest]);

        // Assert
        assert.deepStrictEqual(harness.errors, []);
        const events = batches.flatMap(batch => batch.events);
        assert.deepStrictEqual(
            events.map(event => [event.metadata.line, event.byteOffset]),
            [
                ['é✓', 0],
                ['plain', 6]
            ]
        );
    });

    it('replays a failed batch from the persisted cursor after resetState', async () => {
        // Arrange: first batch ingests fine and its cursor persists.
        const harness = createHarness();
        const { tailer, batches, poll, stopPersistingCursors, resumePersistingCursors } =
            harness.makeTailer();
        fs.writeFileSync(logFile, 'first\n');
        await poll([manifest]);

        // Act: the second batch's durable ingest "fails" — its cursor never
        // persists and (as ScannerEngine does on ingest failure) the tailer's
        // in-memory state for the file is invalidated.
        stopPersistingCursors();
        fs.appendFileSync(logFile, 'second\n');
        await poll([manifest]);
        tailer.resetState(manifest.id, logFile);

        // Ingest is healthy again; more lines arrive before the next poll.
        resumePersistingCursors();
        fs.appendFileSync(logFile, 'third\n');
        await poll([manifest]);

        // Assert: the next poll resumed from the last PERSISTED cursor, so
        // the failed line is re-read (not lost) and the replay derives the
        // SAME envelope id as the failed attempt (deduped downstream).
        assert.deepStrictEqual(harness.errors, []);
        assert.deepStrictEqual(eventLines(batches), ['first', 'second', 'second', 'third']);
        const failedAttempt = batches[1].events[0];
        const replay = batches[2].events[0];
        assert.strictEqual(replay.byteOffset, failedAttempt.byteOffset);
        assert.strictEqual(
            deriveEnvelopeId(manifest.id, logFile, String(replay.byteOffset), replay.lineHash, 'ai.tokens'),
            deriveEnvelopeId(
                manifest.id,
                logFile,
                String(failedAttempt.byteOffset),
                failedAttempt.lineHash,
                'ai.tokens'
            )
        );
        // 'third' appears exactly once and the cursor covers all 19 bytes.
        assert.strictEqual(eventLines(batches).filter(line => line === 'third').length, 1);
        assert.strictEqual(batches.at(-1)?.cursor.byte_offset, 19);
    });

    it('marks batches emitted before resetState stale so a queued later batch cannot outrun the failed one', async () => {
        // Arrange: "first" ingests fine; then ingest starts failing while
        // the poll loop keeps running, so TWO more batches are emitted whose
        // cursors never persist (both still queued in the engine's chain).
        const harness = createHarness();
        const { tailer, batches, poll, stopPersistingCursors, resumePersistingCursors } =
            harness.makeTailer();
        fs.writeFileSync(logFile, 'first\n');
        await poll([manifest]);
        stopPersistingCursors();
        fs.appendFileSync(logFile, 'second\n');
        await poll([manifest]);
        fs.appendFileSync(logFile, 'third\n');
        await poll([manifest]);

        // Act: the first queued batch's ingest fails — the engine resets the
        // tailer state for the file.
        tailer.resetState(manifest.id, logFile);

        // Assert: BOTH outstanding batches are stale. The later one carries
        // cursor byte_offset=19; committing it would persist the cursor PAST
        // the failed batch's rolled-back "second" line forever.
        assert.strictEqual(tailer.isCurrentGeneration(batches[1]), false);
        assert.strictEqual(tailer.isCurrentGeneration(batches[2]), false);

        // The post-reset poll replays both lines from the persisted cursor
        // in one current-generation batch — the only writer allowed to
        // advance the cursor — at the original offsets (so ids dedup).
        resumePersistingCursors();
        await poll([manifest]);
        const replay = batches[3];
        assert.strictEqual(tailer.isCurrentGeneration(replay), true);
        assert.deepStrictEqual(eventLines([replay]), ['second', 'third']);
        assert.strictEqual(replay.events[0].byteOffset, batches[1].events[0].byteOffset);
        assert.strictEqual(replay.cursor.byte_offset, 19);
        assert.deepStrictEqual(harness.errors, []);
    });

    it('abandons an in-flight tail when resetState fires mid-parse', async () => {
        // Arrange: "first" ingests and its cursor persists.
        const harness = createHarness();
        const { tailer, batches, poll, setParseHook } = harness.makeTailer();
        fs.writeFileSync(logFile, 'first\n');
        await poll([manifest]);

        // Act: while the next poll is parsing "second", an earlier batch's
        // ingest failure triggers resetState — the poll already holds a
        // reference to the (now orphaned) tail state mid-tailFile.
        setParseHook(line => {
            if (line === 'second') {
                tailer.resetState(manifest.id, logFile);
            }
        });
        fs.appendFileSync(logFile, 'second\n');
        await poll([manifest]);
        const batchCountAfterReset = batches.length;
        setParseHook(null);
        await poll([manifest]);

        // Assert: the interrupted poll emitted nothing from the orphaned
        // state; the next poll re-read "second" from the persisted cursor
        // under the new generation, losing and duplicating nothing.
        assert.strictEqual(batchCountAfterReset, 1);
        assert.deepStrictEqual(eventLines(batches), ['first', 'second']);
        assert.strictEqual(tailer.isCurrentGeneration(batches[1]), true);
        assert.strictEqual(batches[1].cursor.byte_offset, 13);
        assert.deepStrictEqual(harness.errors, []);
    });
});
