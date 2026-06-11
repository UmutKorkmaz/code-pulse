import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { DatabaseV5 } from '@codepulse/core';
import { ENVELOPE_VERSION, type AnyEnvelope } from '@codepulse/protocol';

interface DailyRow {
    ai_session_id: string;
    day: string;
    active_seconds: number;
}

interface DatabaseInternals {
    run(sql: string, params?: unknown[]): Promise<unknown>;
    all<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

function tokensEnvelope(id: string, ts: number, aiSessionId: string): AnyEnvelope {
    return {
        v: ENVELOPE_VERSION,
        id,
        ts,
        src: 'scanner',
        type: 'ai.tokens',
        payload: {
            type: 'ai.tokens',
            usage: {
                inputTokens: 100,
                outputTokens: 50,
                totalTokens: 150,
                model: 'model-a',
                isEstimated: false,
                aiSessionId,
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
    ts: number,
    endedAt?: string
): AnyEnvelope {
    return {
        v: ENVELOPE_VERSION,
        id,
        ts,
        src: 'scanner',
        type,
        payload: {
            type,
            aiSession: {
                id: aiSessionId,
                scannerId: 'scn.test',
                tool: 'claude-code',
                startedAt: new Date(ts).toISOString(),
                endedAt,
                confidence: 0.9,
                source: 'process'
            }
        }
    };
}

function localDay(ms: number): string {
    const date = new Date(ms);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Yesterday's local midnight — fully in the past whenever the suite runs. */
function yesterdayMidnightMs(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
}

/** Local noon yesterday — anchored away from any midnight boundary. */
function yesterdayNoonMs(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).getTime();
}

describe('DatabaseV5 per-day active-time buckets (ai_activity_daily)', () => {
    let tempDir = '';
    let database: DatabaseV5;

    const internals = (): DatabaseInternals => database as unknown as DatabaseInternals;
    const listDailyRows = (aiSessionId: string): Promise<DailyRow[]> =>
        internals().all<DailyRow>(
            `
                SELECT ai_session_id, day, active_seconds
                FROM ai_activity_daily
                WHERE ai_session_id = ?
                ORDER BY day ASC
            `,
            [aiSessionId]
        );

    beforeEach(async () => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-ai-daily-'));
        database = new DatabaseV5(tempDir);
        await database.open();
    });

    afterEach(async () => {
        await database.close();
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    /**
     * Standard straddle fixture: session starts 100s before yesterday's local
     * midnight, then a tokens event lands 100s after midnight. The start event
     * cannot credit time before started_at, and the 200s gap is in-window, so
     * the credit splits 100s/100s across the two days.
     */
    async function ingestMidnightStraddle(aiSessionId: string): Promise<{
        dayBefore: string;
        dayAfter: string;
    }> {
        const midnightMs = yesterdayMidnightMs();
        const startTs = midnightMs - 100_000;
        const tokensTs = midnightMs + 100_000;
        await database.ingestEnvelopeFromSpool(
            aiSessionEnvelope(`env-${aiSessionId}-start`, 'ai.session.started', aiSessionId, startTs)
        );
        await database.ingestEnvelopeFromSpool(
            tokensEnvelope(`env-${aiSessionId}-tok`, tokensTs, aiSessionId)
        );
        await database.ingestEnvelopeFromSpool(
            aiSessionEnvelope(
                `env-${aiSessionId}-end`,
                'ai.session.ended',
                aiSessionId,
                startTs,
                new Date(tokensTs).toISOString()
            )
        );
        return { dayBefore: localDay(startTs), dayAfter: localDay(tokensTs) };
    }

    it('splits a credited gap straddling local midnight across both daily buckets', async () => {
        // Act
        const { dayBefore, dayAfter } = await ingestMidnightStraddle('ai-straddle');

        // Assert: the 100s pre-midnight portion of the gap lands on the first
        // day, and the 100s post-midnight portion lands on the second.
        const rows = await listDailyRows('ai-straddle');
        assert.deepStrictEqual(rows, [
            { ai_session_id: 'ai-straddle', day: dayBefore, active_seconds: 100 },
            { ai_session_id: 'ai-straddle', day: dayAfter, active_seconds: 100 }
        ]);
        const session = await database.getAiSession('ai-straddle');
        assert.ok(session);
        assert.strictEqual(session.active_duration, 200);
    });

    it('returns exact per-day active_ms from listAiActivityByDay for a midnight-straddling session', async () => {
        // Arrange
        const { dayBefore, dayAfter } = await ingestMidnightStraddle('ai-straddle');

        // Act
        const rows = await database.listAiActivityByDay();

        // Assert: each day reports exactly the active time credited inside it.
        const before = rows.find(row => row.day === dayBefore);
        const after = rows.find(row => row.day === dayAfter);
        assert.ok(before, 'missing day row before midnight');
        assert.ok(after, 'missing day row after midnight');
        assert.strictEqual(before.activeMs, 100_000);
        assert.strictEqual(after.activeMs, 100_000);
    });

    it('keeps a same-day session in one bucket holding the session total', async () => {
        // Arrange: 90s session at noon yesterday — the start event credits no
        // pre-start time, then a 60s in-window tokens gap lands in one bucket.
        const startMs = yesterdayNoonMs();
        await database.ingestEnvelopeFromSpool(
            aiSessionEnvelope('env-same-start', 'ai.session.started', 'ai-same-day', startMs)
        );
        await database.ingestEnvelopeFromSpool(
            tokensEnvelope('env-same-tok', startMs + 60_000, 'ai-same-day')
        );
        await database.ingestEnvelopeFromSpool(
            aiSessionEnvelope(
                'env-same-end',
                'ai.session.ended',
                'ai-same-day',
                startMs,
                new Date(startMs + 90_000).toISOString()
            )
        );

        // Assert: the session total is mirrored by a single daily bucket, and
        // the day aggregate reports the same value.
        const session = await database.getAiSession('ai-same-day');
        assert.ok(session);
        assert.strictEqual(session.active_duration, 60);
        const dailyRows = await listDailyRows('ai-same-day');
        assert.deepStrictEqual(dailyRows, [
            { ai_session_id: 'ai-same-day', day: localDay(startMs), active_seconds: 60 }
        ]);
        const dayRow = (await database.listAiActivityByDay()).find(
            row => row.day === localDay(startMs)
        );
        assert.ok(dayRow);
        assert.strictEqual(dayRow.activeMs, 60_000);
    });

    it('credits nothing — in either store — for an out-of-order event', async () => {
        // Arrange: a session started before its first token event, followed by
        // two in-order token events 500s apart (30s + 30s isolated grants).
        const baseTs = yesterdayNoonMs();
        await database.ingestEnvelopeFromSpool(
            aiSessionEnvelope(
                'env-ooo-start',
                'ai.session.started',
                'ai-ooo',
                baseTs - 30_000
            )
        );
        await database.ingestEnvelopeFromSpool(
            tokensEnvelope('env-ooo-1', baseTs, 'ai-ooo')
        );
        await database.ingestEnvelopeFromSpool(
            tokensEnvelope('env-ooo-2', baseTs + 500_000, 'ai-ooo')
        );

        // Act: an event 100s BEFORE the last activity.
        await database.ingestEnvelopeFromSpool(
            tokensEnvelope('env-ooo-3', baseTs + 400_000, 'ai-ooo')
        );

        // Assert: neither the running total nor the daily bucket moved.
        const session = await database.getAiSession('ai-ooo');
        assert.ok(session);
        assert.strictEqual(session.active_duration, 60);
        const dailyRows = await listDailyRows('ai-ooo');
        assert.deepStrictEqual(dailyRows, [
            { ai_session_id: 'ai-ooo', day: localDay(baseTs), active_seconds: 60 }
        ]);
    });

    it('bounds a first post-midnight event at the session start day', async () => {
        // Arrange: the first activity arrives 10s after local midnight for a
        // session that began at midnight. The isolated grant must not reach
        // back into the previous local day.
        const midnightMs = yesterdayMidnightMs();
        await database.insertAiSession({
            id: 'ai-midnight-first',
            session_id: null,
            scanner_id: 'scn.test',
            tool: 'claude-code',
            model: null,
            started_at: new Date(midnightMs).toISOString(),
            ended_at: null,
            confidence: 0.9,
            source: 'process'
        });

        // Act
        await database.ingestEnvelopeFromSpool(
            tokensEnvelope('env-midnight-first-token', midnightMs + 10_000, 'ai-midnight-first')
        );

        // Assert
        const session = await database.getAiSession('ai-midnight-first');
        assert.ok(session);
        assert.strictEqual(session.active_duration, 10);
        assert.deepStrictEqual(await listDailyRows('ai-midnight-first'), [
            {
                ai_session_id: 'ai-midnight-first',
                day: localDay(midnightMs),
                active_seconds: 10
            }
        ]);
    });

    it('re-runs migration v8 idempotently without clobbering daily buckets', async () => {
        // Arrange: accumulate straddling buckets, then force the version back
        // to 7 so the next open re-applies v8 on an already-migrated db.
        const { dayBefore, dayAfter } = await ingestMidnightStraddle('ai-straddle');
        await internals().run(`UPDATE meta SET value = '7' WHERE key = 'schema_version'`);
        await database.close();

        // Act
        database = new DatabaseV5(tempDir);
        await database.open();

        // Assert
        assert.strictEqual(await database.getSchemaVersion(), 8);
        const rows = await listDailyRows('ai-straddle');
        assert.deepStrictEqual(rows, [
            { ai_session_id: 'ai-straddle', day: dayBefore, active_seconds: 100 },
            { ai_session_id: 'ai-straddle', day: dayAfter, active_seconds: 100 }
        ]);
    });

    it('keeps ai_sessions.active_duration equal to the sum of its daily buckets', async () => {
        // Arrange: a mix of credited intervals — an in-window gap straddling
        // midnight and a post-window isolated grant (all whole seconds).
        const midnightMs = yesterdayMidnightMs();
        const startTs = midnightMs - 100_000;
        await database.ingestEnvelopeFromSpool(
            aiSessionEnvelope('env-parity-start', 'ai.session.started', 'ai-parity', startTs)
        );
        await database.ingestEnvelopeFromSpool(
            tokensEnvelope('env-parity-tok-1', midnightMs + 100_000, 'ai-parity')
        );
        await database.ingestEnvelopeFromSpool(
            tokensEnvelope('env-parity-tok-2', midnightMs + 500_000, 'ai-parity')
        );

        // Assert: 200 (split gap) + 30 (isolated) = 230, and the
        // daily buckets sum to exactly the session running total.
        const session = await database.getAiSession('ai-parity');
        assert.ok(session);
        assert.strictEqual(session.active_duration, 230);
        const dailyRows = await listDailyRows('ai-parity');
        const bucketTotal = dailyRows.reduce((sum, row) => sum + row.active_seconds, 0);
        assert.strictEqual(bucketTotal, session.active_duration);
    });
});
