import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { DatabaseV5 } from '@codepulse/core';
import { ENVELOPE_VERSION, type AnyEnvelope } from '@codepulse/protocol';

const DAY = '2026-06-10';
const TS = Date.UTC(2026, 5, 10, 12, 0, 0);

function tokensEnvelope(
    id: string,
    options: {
        aiSessionId?: string;
        inputTokens?: number;
        outputTokens?: number;
        model?: string;
        ts?: number;
    } = {}
): AnyEnvelope {
    return {
        v: ENVELOPE_VERSION,
        id,
        ts: options.ts ?? TS,
        src: 'scanner',
        type: 'ai.tokens',
        payload: {
            type: 'ai.tokens',
            usage: {
                inputTokens: options.inputTokens ?? 100,
                outputTokens: options.outputTokens ?? 50,
                cacheReadTokens: 10,
                cacheWriteTokens: 5,
                totalTokens:
                    (options.inputTokens ?? 100) + (options.outputTokens ?? 50) + 15,
                model: options.model ?? 'model-a',
                isEstimated: false,
                aiSessionId: options.aiSessionId,
                scannerId: 'scn.test',
                tool: 'claude-code'
            }
        }
    };
}

function aiSessionEnvelope(
    id: string,
    type: 'ai.session.started' | 'ai.session.ended',
    aiSessionId: string,
    options: { endedAt?: string } = {}
): AnyEnvelope {
    return {
        v: ENVELOPE_VERSION,
        id,
        ts: TS,
        src: 'scanner',
        type,
        payload: {
            type,
            aiSession: {
                id: aiSessionId,
                scannerId: 'scn.test',
                tool: 'claude-code',
                model: 'model-a',
                startedAt: new Date(TS).toISOString(),
                endedAt: options.endedAt,
                confidence: 0.9,
                source: 'log'
            }
        }
    };
}

function codingSessionEnvelope(
    id: string,
    type: 'session.updated' | 'session.ended',
    options: { duration?: number; isActive?: boolean } = {}
): AnyEnvelope {
    return {
        v: ENVELOPE_VERSION,
        id,
        ts: TS,
        src: 'vscode',
        type,
        payload: {
            type,
            session: {
                id: 'cs-1',
                startTime: new Date(TS).toISOString(),
                duration: options.duration ?? 120,
                idleDuration: 10,
                project: 'code-pulse',
                language: 'typescript',
                file: 'src/app.ts',
                branch: 'main',
                isActive: options.isActive ?? true,
                heartbeats: 5,
                keystrokes: 100,
                linesAdded: 10,
                linesRemoved: 2,
                tags: ['focus']
            }
        }
    };
}

interface SessionsTableRow {
    id: string;
    duration: number;
    is_active: number;
    end_time: string | null;
}

function querySessions(database: DatabaseV5, sessionId: string): Promise<SessionsTableRow[]> {
    // The sessions table has no public read API yet; reach through the
    // private promise helper rather than opening a second connection.
    return (database as unknown as {
        all<T>(sql: string, params?: unknown[]): Promise<T[]>;
    }).all<SessionsTableRow>('SELECT id, duration, is_active, end_time FROM sessions WHERE id = ?', [
        sessionId
    ]);
}

describe('DatabaseV5 envelope ingest', () => {
    let tempDir = '';
    let database: DatabaseV5;

    beforeEach(async () => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-db-'));
        database = new DatabaseV5(tempDir);
        await database.open();
    });

    afterEach(async () => {
        await database.close();
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('ingests the same envelope twice but records only one token usage row', async () => {
        // Arrange
        const envelope = tokensEnvelope('env-dup-1', { aiSessionId: 'ai-sess-dup' });

        // Act
        const firstIngest = await database.ingestEnvelopeFromSpool(envelope);
        const replayIngest = await database.ingestEnvelopeFromSpool(envelope);

        // Assert
        assert.strictEqual(firstIngest, true);
        assert.strictEqual(replayIngest, false);
        const usage = await database.listAiTokenUsage('ai-sess-dup');
        assert.strictEqual(usage.length, 1);
        assert.strictEqual(usage[0].envelope_id, 'env-dup-1');
        assert.strictEqual(usage[0].input_tokens, 100);
    });

    it('aggregates a session.started -> ai.tokens -> session.ended sequence', async () => {
        // Arrange
        const started = aiSessionEnvelope('env-start-1', 'ai.session.started', 'ai-sess-seq');
        const tokens = tokensEnvelope('env-tokens-1', {
            aiSessionId: 'ai-sess-seq',
            inputTokens: 100,
            outputTokens: 50,
            model: 'model-a'
        });
        const endedAt = new Date(TS + 60_000).toISOString();
        const ended = aiSessionEnvelope('env-end-1', 'ai.session.ended', 'ai-sess-seq', {
            endedAt
        });

        // Act
        assert.strictEqual(await database.ingestEnvelopeFromSpool(started), true);
        assert.strictEqual(await database.ingestEnvelopeFromSpool(tokens), true);
        assert.strictEqual(await database.ingestEnvelopeFromSpool(ended), true);

        // Assert
        const session = await database.getAiSession('ai-sess-seq');
        assert.ok(session);
        assert.strictEqual(session.tool, 'claude-code');
        assert.strictEqual(session.ended_at, endedAt);

        const aggregates = await database.aggregateTokenUsageByDay(DAY);
        assert.strictEqual(aggregates.length, 1);
        assert.strictEqual(aggregates[0].tool, 'claude-code');
        assert.strictEqual(aggregates[0].model, 'model-a');
        assert.strictEqual(aggregates[0].inputTokens, 100);
        assert.strictEqual(aggregates[0].outputTokens, 50);
        assert.strictEqual(aggregates[0].cacheReadTokens, 10);
        assert.strictEqual(aggregates[0].cacheWriteTokens, 5);
        assert.strictEqual(aggregates[0].totalTokens, 165);
        assert.strictEqual(aggregates[0].estimatedRows, 0);

        // Replayed session.ended is a no-op once the session is closed.
        assert.strictEqual(await database.ingestEnvelopeFromSpool(ended), false);
    });

    it('upserts session.updated and session.ended into a single sessions row', async () => {
        // Arrange
        const firstUpdate = codingSessionEnvelope('env-cs-1', 'session.updated', {
            duration: 120
        });
        const secondUpdate = codingSessionEnvelope('env-cs-2', 'session.updated', {
            duration: 240
        });
        const ended = codingSessionEnvelope('env-cs-3', 'session.ended', {
            duration: 300,
            isActive: true
        });

        // Act
        assert.strictEqual(await database.ingestEnvelopeFromSpool(firstUpdate), true);
        assert.strictEqual(await database.ingestEnvelopeFromSpool(secondUpdate), true);
        const afterUpdates = await querySessions(database, 'cs-1');

        assert.strictEqual(await database.ingestEnvelopeFromSpool(ended), true);
        const afterEnded = await querySessions(database, 'cs-1');

        // Assert: repeated envelopes converge on one row keyed by session id.
        assert.strictEqual(afterUpdates.length, 1);
        assert.strictEqual(afterUpdates[0].duration, 240);
        assert.strictEqual(afterUpdates[0].is_active, 1);

        assert.strictEqual(afterEnded.length, 1);
        assert.strictEqual(afterEnded[0].duration, 300);
        assert.strictEqual(afterEnded[0].is_active, 0);
        assert.strictEqual(afterEnded[0].end_time, new Date(TS).toISOString());
    });

    it('round-trips parser cursors through upsert and get', async () => {
        // Arrange
        const cursor = {
            scanner_id: 'scn.test',
            log_glob: '/tmp/logs/session.jsonl',
            byte_offset: 42,
            inode: '12345',
            last_event_id: 'hash-1'
        };

        // Act
        await database.upsertParserCursor(cursor);
        const stored = await database.getParserCursor('scn.test', '/tmp/logs/session.jsonl');

        await database.upsertParserCursor({
            ...cursor,
            byte_offset: 100,
            inode: '67890',
            last_event_id: null
        });
        const updated = await database.getParserCursor('scn.test', '/tmp/logs/session.jsonl');

        // Assert
        assert.deepStrictEqual(stored, cursor);
        assert.deepStrictEqual(updated, {
            ...cursor,
            byte_offset: 100,
            inode: '67890',
            last_event_id: null
        });
        assert.strictEqual(await database.getParserCursor('scn.test', '/tmp/other.jsonl'), null);
    });

    it('ingests a log batch and its cursor atomically, filtering replays', async () => {
        // Arrange
        const envelopes = [
            tokensEnvelope('env-batch-1', { aiSessionId: 'ai-sess-batch' }),
            tokensEnvelope('env-batch-2', { aiSessionId: 'ai-sess-batch' })
        ];
        const cursor = {
            scanner_id: 'scn.test',
            log_glob: '/tmp/logs/batch.jsonl',
            byte_offset: 256,
            inode: '111',
            last_event_id: 'hash-batch'
        };

        // Act
        const ingested = await database.ingestLogBatchWithCursor(envelopes, cursor);
        const replayed = await database.ingestLogBatchWithCursor(envelopes, {
            ...cursor,
            byte_offset: 512
        });

        // Assert
        assert.deepStrictEqual(
            ingested.map(envelope => envelope.id),
            ['env-batch-1', 'env-batch-2']
        );
        assert.deepStrictEqual(replayed, []);
        const usage = await database.listAiTokenUsage('ai-sess-batch');
        assert.strictEqual(usage.length, 2);
        const stored = await database.getParserCursor('scn.test', '/tmp/logs/batch.jsonl');
        assert.strictEqual(stored?.byte_offset, 512);
    });

    it('keeps an independent write out of a concurrently failing transaction', async () => {
        // Arrange: a batch whose cursor upsert violates NOT NULL, forcing
        // the whole transaction to roll back AFTER its envelope statements
        // already ran on the shared connection.
        const failingBatch = database.ingestLogBatchWithCursor(
            [tokensEnvelope('env-rollback-1', { aiSessionId: 'ai-sess-rollback' })],
            {
                scanner_id: 'scn.test',
                log_glob: null as unknown as string,
                byte_offset: 1,
                inode: null,
                last_event_id: null
            }
        );

        // Act: issue an unrelated write while that transaction is open — it
        // must queue behind the transaction instead of joining it and dying
        // with the rollback.
        const audit = database.insertPrivacyAudit({
            actor: 'test',
            operation: 'concurrent-write',
            target_hash: null,
            occurred_at: new Date(TS).toISOString()
        });
        await assert.rejects(failingBatch, /NOT NULL/);
        await audit;

        // Assert: the transaction's effects rolled back, the independent
        // write committed.
        const usage = await database.listAiTokenUsage('ai-sess-rollback');
        assert.strictEqual(usage.length, 0);
        assert.strictEqual(await database.getAiSession('ai-sess-rollback'), null);
        const audits = await database.listPrivacyAudit();
        assert.strictEqual(audits.length, 1);
        assert.strictEqual(audits[0].operation, 'concurrent-write');
    });

    it('serializes parallel transactions and direct writes without deadlocking', async () => {
        // Arrange / Act: transactions (which run statements through the same
        // queue they sit in) interleaved with direct writes — all in flight
        // at once.
        const ingests = ['env-mix-1', 'env-mix-2', 'env-mix-3'].map(id =>
            database.ingestEnvelopeFromSpool(tokensEnvelope(id, { aiSessionId: 'ai-sess-mix' }))
        );
        const directWrites = [
            database.insertPrivacyAudit({
                actor: 'test',
                operation: 'parallel-audit',
                target_hash: null,
                occurred_at: new Date(TS).toISOString()
            }),
            database.upsertRegistryScanner({
                id: 'scn.parallel',
                version: '1.0.0',
                trust: 'official',
                enabled: 1,
                installed_at: new Date(TS).toISOString(),
                last_scan_at: null,
                manifest_hash: 'hash'
            })
        ];
        const results = await Promise.all([...ingests, ...directWrites]);

        // Assert: every ingest landed exactly once alongside the writes.
        assert.deepStrictEqual(results.slice(0, 3), [true, true, true]);
        const usage = await database.listAiTokenUsage('ai-sess-mix');
        assert.strictEqual(usage.length, 3);
        const scanners = await database.listRegistryScanners();
        assert.strictEqual(scanners.filter(scanner => scanner.id === 'scn.parallel').length, 1);
        const audits = await database.listPrivacyAudit();
        assert.strictEqual(audits.filter(entry => entry.operation === 'parallel-audit').length, 1);
    });
});
