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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const nodePath = __importStar(require("path"));
const core_1 = require("@codepulse/core");
const protocol_1 = require("@codepulse/protocol");
const DAY = '2026-06-10';
const TS = Date.UTC(2026, 5, 10, 12, 0, 0);
function tokensEnvelope(id, options = {}) {
    return {
        v: protocol_1.ENVELOPE_VERSION,
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
                totalTokens: (options.inputTokens ?? 100) + (options.outputTokens ?? 50) + 15,
                model: options.model ?? 'model-a',
                isEstimated: false,
                aiSessionId: options.aiSessionId,
                scannerId: 'scn.test',
                tool: 'claude-code'
            }
        }
    };
}
function aiSessionEnvelope(id, type, aiSessionId, options = {}) {
    return {
        v: protocol_1.ENVELOPE_VERSION,
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
function codingSessionEnvelope(id, type, options = {}) {
    return {
        v: protocol_1.ENVELOPE_VERSION,
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
function querySessions(database, sessionId) {
    // The sessions table has no public read API yet; reach through the
    // private promise helper rather than opening a second connection.
    return database.all('SELECT id, duration, is_active, end_time FROM sessions WHERE id = ?', [
        sessionId
    ]);
}
describe('DatabaseV5 envelope ingest', () => {
    let tempDir = '';
    let database;
    beforeEach(async () => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-db-'));
        database = new core_1.DatabaseV5(tempDir);
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
        assert_1.default.strictEqual(firstIngest, true);
        assert_1.default.strictEqual(replayIngest, false);
        const usage = await database.listAiTokenUsage('ai-sess-dup');
        assert_1.default.strictEqual(usage.length, 1);
        assert_1.default.strictEqual(usage[0].envelope_id, 'env-dup-1');
        assert_1.default.strictEqual(usage[0].input_tokens, 100);
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
        const endedAt = new Date(TS + 60000).toISOString();
        const ended = aiSessionEnvelope('env-end-1', 'ai.session.ended', 'ai-sess-seq', {
            endedAt
        });
        // Act
        assert_1.default.strictEqual(await database.ingestEnvelopeFromSpool(started), true);
        assert_1.default.strictEqual(await database.ingestEnvelopeFromSpool(tokens), true);
        assert_1.default.strictEqual(await database.ingestEnvelopeFromSpool(ended), true);
        // Assert
        const session = await database.getAiSession('ai-sess-seq');
        assert_1.default.ok(session);
        assert_1.default.strictEqual(session.tool, 'claude-code');
        assert_1.default.strictEqual(session.ended_at, endedAt);
        const aggregates = await database.aggregateTokenUsageByDay(DAY);
        assert_1.default.strictEqual(aggregates.length, 1);
        assert_1.default.strictEqual(aggregates[0].tool, 'claude-code');
        assert_1.default.strictEqual(aggregates[0].model, 'model-a');
        assert_1.default.strictEqual(aggregates[0].inputTokens, 100);
        assert_1.default.strictEqual(aggregates[0].outputTokens, 50);
        assert_1.default.strictEqual(aggregates[0].cacheReadTokens, 10);
        assert_1.default.strictEqual(aggregates[0].cacheWriteTokens, 5);
        assert_1.default.strictEqual(aggregates[0].totalTokens, 165);
        assert_1.default.strictEqual(aggregates[0].estimatedRows, 0);
        // Replayed session.ended is a no-op once the session is closed.
        assert_1.default.strictEqual(await database.ingestEnvelopeFromSpool(ended), false);
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
        assert_1.default.strictEqual(await database.ingestEnvelopeFromSpool(firstUpdate), true);
        assert_1.default.strictEqual(await database.ingestEnvelopeFromSpool(secondUpdate), true);
        const afterUpdates = await querySessions(database, 'cs-1');
        assert_1.default.strictEqual(await database.ingestEnvelopeFromSpool(ended), true);
        const afterEnded = await querySessions(database, 'cs-1');
        // Assert: repeated envelopes converge on one row keyed by session id.
        assert_1.default.strictEqual(afterUpdates.length, 1);
        assert_1.default.strictEqual(afterUpdates[0].duration, 240);
        assert_1.default.strictEqual(afterUpdates[0].is_active, 1);
        assert_1.default.strictEqual(afterEnded.length, 1);
        assert_1.default.strictEqual(afterEnded[0].duration, 300);
        assert_1.default.strictEqual(afterEnded[0].is_active, 0);
        assert_1.default.strictEqual(afterEnded[0].end_time, new Date(TS).toISOString());
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
        assert_1.default.deepStrictEqual(stored, cursor);
        assert_1.default.deepStrictEqual(updated, {
            ...cursor,
            byte_offset: 100,
            inode: '67890',
            last_event_id: null
        });
        assert_1.default.strictEqual(await database.getParserCursor('scn.test', '/tmp/other.jsonl'), null);
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
        assert_1.default.deepStrictEqual(ingested.map(envelope => envelope.id), ['env-batch-1', 'env-batch-2']);
        assert_1.default.deepStrictEqual(replayed, []);
        const usage = await database.listAiTokenUsage('ai-sess-batch');
        assert_1.default.strictEqual(usage.length, 2);
        const stored = await database.getParserCursor('scn.test', '/tmp/logs/batch.jsonl');
        assert_1.default.strictEqual(stored?.byte_offset, 512);
    });
    it('keeps an independent write out of a concurrently failing transaction', async () => {
        // Arrange: a batch whose cursor upsert violates NOT NULL, forcing
        // the whole transaction to roll back AFTER its envelope statements
        // already ran on the shared connection.
        const failingBatch = database.ingestLogBatchWithCursor([tokensEnvelope('env-rollback-1', { aiSessionId: 'ai-sess-rollback' })], {
            scanner_id: 'scn.test',
            log_glob: null,
            byte_offset: 1,
            inode: null,
            last_event_id: null
        });
        // Act: issue an unrelated write while that transaction is open — it
        // must queue behind the transaction instead of joining it and dying
        // with the rollback.
        const audit = database.insertPrivacyAudit({
            actor: 'test',
            operation: 'concurrent-write',
            target_hash: null,
            occurred_at: new Date(TS).toISOString()
        });
        await assert_1.default.rejects(failingBatch, /NOT NULL/);
        await audit;
        // Assert: the transaction's effects rolled back, the independent
        // write committed.
        const usage = await database.listAiTokenUsage('ai-sess-rollback');
        assert_1.default.strictEqual(usage.length, 0);
        assert_1.default.strictEqual(await database.getAiSession('ai-sess-rollback'), null);
        const audits = await database.listPrivacyAudit();
        assert_1.default.strictEqual(audits.length, 1);
        assert_1.default.strictEqual(audits[0].operation, 'concurrent-write');
    });
    it('serializes parallel transactions and direct writes without deadlocking', async () => {
        // Arrange / Act: transactions (which run statements through the same
        // queue they sit in) interleaved with direct writes — all in flight
        // at once.
        const ingests = ['env-mix-1', 'env-mix-2', 'env-mix-3'].map(id => database.ingestEnvelopeFromSpool(tokensEnvelope(id, { aiSessionId: 'ai-sess-mix' })));
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
        assert_1.default.deepStrictEqual(results.slice(0, 3), [true, true, true]);
        const usage = await database.listAiTokenUsage('ai-sess-mix');
        assert_1.default.strictEqual(usage.length, 3);
        const scanners = await database.listRegistryScanners();
        assert_1.default.strictEqual(scanners.filter(scanner => scanner.id === 'scn.parallel').length, 1);
        const audits = await database.listPrivacyAudit();
        assert_1.default.strictEqual(audits.filter(entry => entry.operation === 'parallel-audit').length, 1);
    });
});
