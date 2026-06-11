import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { DatabaseV5 } from '@codepulse/core';
import { ENVELOPE_VERSION, type AnyEnvelope, type EvidenceType } from '@codepulse/protocol';

const TS = Date.UTC(2026, 5, 10, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

interface DatabaseInternals {
    run(sql: string, params?: unknown[]): Promise<unknown>;
}

function toolDetectedEnvelope(
    id: string,
    options: {
        ts?: number;
        tool?: string;
        scannerId?: string;
        src?: 'scanner' | 'vscode' | 'daemon';
        evidenceType?: EvidenceType;
    } = {}
): AnyEnvelope {
    const ts = options.ts ?? TS;
    return {
        v: ENVELOPE_VERSION,
        id,
        ts,
        src: options.src ?? 'scanner',
        type: 'ai.tool.detected',
        payload: {
            type: 'ai.tool.detected',
            tool: options.tool ?? 'claude-code',
            confidence: 0.4,
            evidence: [
                {
                    type: options.evidenceType ?? 'process',
                    timestamp: new Date(ts).toISOString(),
                    hash: `hash-${id}`
                }
            ],
            scannerId: options.scannerId ?? 'scn.test'
        }
    };
}

function tokensEnvelope(
    id: string,
    options: { ts?: number; aiSessionId?: string; tool?: string } = {}
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
                inputTokens: 100,
                outputTokens: 50,
                totalTokens: 150,
                model: 'model-a',
                isEstimated: false,
                aiSessionId: options.aiSessionId,
                scannerId: 'scn.test',
                tool: options.tool ?? 'claude-code'
            }
        }
    };
}

function aiSessionEnvelope(
    id: string,
    type: 'ai.session.started' | 'ai.session.ended',
    aiSessionId: string,
    options: { ts?: number; startedAt?: string; endedAt?: string; tool?: string } = {}
): AnyEnvelope {
    const ts = options.ts ?? TS;
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
                tool: options.tool ?? 'claude-code',
                startedAt: options.startedAt ?? new Date(ts).toISOString(),
                endedAt: options.endedAt,
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

describe('DatabaseV5 AI activity tracking', () => {
    let tempDir = '';
    let database: DatabaseV5;

    beforeEach(async () => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-ai-activity-'));
        database = new DatabaseV5(tempDir);
        await database.open();
    });

    afterEach(async () => {
        await database.close();
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    async function insertAccumulatorSession(id: string, startedAtMs = TS - 60_000): Promise<void> {
        await database.insertAiSession({
            id,
            session_id: null,
            scanner_id: 'scn.test',
            tool: 'claude-code',
            model: null,
            started_at: new Date(startedAtMs).toISOString(),
            ended_at: null,
            confidence: 0.9,
            source: 'process'
        });
    }

    describe('activity accumulator', () => {
        it('grants the 30s isolated minimum to the first event', async () => {
            // Arrange: the session began before the first observed activity,
            // so the trailing isolated grant fits inside the run span.
            await insertAccumulatorSession('ai-acc-1');

            // Act
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-1', { ts: TS, aiSessionId: 'ai-acc-1' })
            );

            // Assert
            const session = await database.getAiSession('ai-acc-1');
            assert.ok(session);
            assert.strictEqual(session.active_duration, 30);
            assert.strictEqual(session.last_activity_at, new Date(TS).toISOString());
        });

        it('adds the real gap when events are 100s apart', async () => {
            // Arrange
            await insertAccumulatorSession('ai-acc-1');
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-1', { ts: TS, aiSessionId: 'ai-acc-1' })
            );

            // Act
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-2', { ts: TS + 100_000, aiSessionId: 'ai-acc-1' })
            );

            // Assert: 30 (first) + 100 (gap)
            const session = await database.getAiSession('ai-acc-1');
            assert.ok(session);
            assert.strictEqual(session.active_duration, 130);
            assert.strictEqual(session.last_activity_at, new Date(TS + 100_000).toISOString());
        });

        it('grants only 30s when the gap exceeds the 300s window', async () => {
            // Arrange
            await insertAccumulatorSession('ai-acc-1');
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-1', { ts: TS, aiSessionId: 'ai-acc-1' })
            );
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-2', { ts: TS + 100_000, aiSessionId: 'ai-acc-1' })
            );

            // Act: 400s after the previous activity
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-3', { ts: TS + 500_000, aiSessionId: 'ai-acc-1' })
            );

            // Assert: 130 + 30 (isolated grant)
            const session = await database.getAiSession('ai-acc-1');
            assert.ok(session);
            assert.strictEqual(session.active_duration, 160);
            assert.strictEqual(session.last_activity_at, new Date(TS + 500_000).toISOString());
        });

        it('grants nothing for out-of-order events and never rewinds last_activity_at', async () => {
            // Arrange
            await insertAccumulatorSession('ai-acc-1');
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-1', { ts: TS, aiSessionId: 'ai-acc-1' })
            );
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-2', { ts: TS + 500_000, aiSessionId: 'ai-acc-1' })
            );

            // Act: out-of-order event 100s BEFORE the last activity
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-4', { ts: TS + 400_000, aiSessionId: 'ai-acc-1' })
            );

            // Assert: 30 + 30 (gap > window) + 0 (already-credited window)
            const session = await database.getAiSession('ai-acc-1');
            assert.ok(session);
            assert.strictEqual(session.active_duration, 60);
            assert.strictEqual(session.last_activity_at, new Date(TS + 500_000).toISOString());
        });

        it('leaves active_duration unchanged when a late event lands inside a credited window', async () => {
            // Arrange: two in-order events 100s apart => 30 + 100
            await insertAccumulatorSession('ai-acc-1');
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-1', { ts: TS, aiSessionId: 'ai-acc-1' })
            );
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-2', { ts: TS + 100_000, aiSessionId: 'ai-acc-1' })
            );

            // Act: a late event 50s into the window the gap grant already paid
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-late', { ts: TS + 50_000, aiSessionId: 'ai-acc-1' })
            );

            // Assert: the late event neither grants nor rewinds anything
            const session = await database.getAiSession('ai-acc-1');
            assert.ok(session);
            assert.strictEqual(session.active_duration, 130);
            assert.strictEqual(session.last_activity_at, new Date(TS + 100_000).toISOString());
        });

        it('does not double-accumulate replayed envelopes', async () => {
            // Arrange
            await insertAccumulatorSession('ai-acc-1');
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-acc-1', { ts: TS, aiSessionId: 'ai-acc-1' })
            );
            const second = tokensEnvelope('env-acc-2', {
                ts: TS + 100_000,
                aiSessionId: 'ai-acc-1'
            });
            await database.ingestEnvelopeFromSpool(second);

            // Act
            const replayed = await database.ingestEnvelopeFromSpool(second);

            // Assert
            assert.strictEqual(replayed, false);
            const session = await database.getAiSession('ai-acc-1');
            assert.ok(session);
            assert.strictEqual(session.active_duration, 130);
        });

        it('feeds token usage events into the accumulator', async () => {
            // Arrange: the start observation is exactly at startedAt, so it
            // credits no synthetic pre-start time.
            await database.ingestEnvelopeFromSpool(
                aiSessionEnvelope('env-start-1', 'ai.session.started', 'ai-sess-tok')
            );

            // Act: tokens 60s later extend the window by the real gap
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-tok-1', { ts: TS + 60_000, aiSessionId: 'ai-sess-tok' })
            );

            // Assert
            const session = await database.getAiSession('ai-sess-tok');
            assert.ok(session);
            assert.strictEqual(session.active_duration, 60);
            assert.strictEqual(session.last_activity_at, new Date(TS + 60_000).toISOString());
        });
    });

    describe('migrations v7/v8', () => {
        it('reaches schema version 8 with NULL/0 activity defaults', async () => {
            // Act
            const version = await database.getSchemaVersion();
            await database.insertAiSession({
                id: 'ai-mig-1',
                session_id: null,
                scanner_id: 'scn.test',
                tool: 'claude-code',
                model: null,
                started_at: new Date(TS).toISOString(),
                ended_at: null,
                confidence: 0.9,
                source: 'process'
            });

            // Assert
            assert.strictEqual(version, 8);
            const session = await database.getAiSession('ai-mig-1');
            assert.ok(session);
            assert.strictEqual(session.last_activity_at, null);
            assert.strictEqual(session.active_duration, 0);
        });

        it('re-runs migrateToV7/V8 idempotently without clobbering accumulated activity', async () => {
            // Arrange: accumulate some activity, then force the version back
            // to 6 so the next open re-applies v7+v8 on an already-migrated db.
            await insertAccumulatorSession('ai-mig-activity');
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-mig-1', { ts: TS, aiSessionId: 'ai-mig-activity' })
            );
            const internals = database as unknown as {
                run(sql: string, params?: unknown[]): Promise<unknown>;
            };
            await internals.run(`UPDATE meta SET value = '6' WHERE key = 'schema_version'`);
            await database.close();

            // Act
            database = new DatabaseV5(tempDir);
            await database.open();

            // Assert
            assert.strictEqual(await database.getSchemaVersion(), 8);
            const session = await database.getAiSession('ai-mig-activity');
            assert.ok(session);
            assert.strictEqual(session.active_duration, 30);
        });
    });

    describe('endStaleAiSessions', () => {
        it('closes only stale open sessions, at their last-activity time', async () => {
            // Arrange
            const now = Date.now();
            const staleTs = now - 20 * 60_000;
            const closedEndedAt = new Date(now - 60 * 60_000).toISOString();
            await database.ingestEnvelopeFromSpool(
                toolDetectedEnvelope('env-stale-1', { ts: staleTs, tool: 'codex' })
            );
            await database.ingestEnvelopeFromSpool(
                toolDetectedEnvelope('env-fresh-1', { ts: now, tool: 'claude-code' })
            );
            await database.ingestEnvelopeFromSpool(
                aiSessionEnvelope('env-closed-start', 'ai.session.started', 'ai-closed', {
                    ts: now - 2 * 60 * 60_000,
                    tool: 'cline'
                })
            );
            await database.ingestEnvelopeFromSpool(
                aiSessionEnvelope('env-closed-end', 'ai.session.ended', 'ai-closed', {
                    ts: now - 2 * 60 * 60_000,
                    tool: 'cline',
                    endedAt: closedEndedAt
                })
            );

            // Act
            const closed = await database.endStaleAiSessions(10);

            // Assert
            assert.strictEqual(closed, 1);
            const stale = await database.getAiSession('env-stale-1');
            assert.ok(stale);
            assert.strictEqual(stale.ended_at, new Date(staleTs).toISOString());
            const fresh = await database.getAiSession('env-fresh-1');
            assert.ok(fresh);
            assert.strictEqual(fresh.ended_at, null);
            const alreadyClosed = await database.getAiSession('ai-closed');
            assert.ok(alreadyClosed);
            assert.strictEqual(alreadyClosed.ended_at, closedEndedAt);
        });

        it('rejects non-finite or negative cutoffs', async () => {
            await assert.rejects(database.endStaleAiSessions(Number.NaN), /non-negative/);
            await assert.rejects(database.endStaleAiSessions(-5), /non-negative/);
        });
    });

    describe('listAiActivityByDay', () => {
        it('aggregates run/active time, session count, and tokens per day and tool', async () => {
            // Arrange: a 90s session with 60s of windowed activity and tokens,
            // anchored at noon yesterday so it can never straddle a midnight.
            const now = new Date();
            const startMs = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate() - 1,
                12
            ).getTime();
            const startedAt = new Date(startMs).toISOString();
            await database.ingestEnvelopeFromSpool(
                aiSessionEnvelope('env-act-start', 'ai.session.started', 'ai-act-1', {
                    ts: startMs,
                    startedAt
                })
            );
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-act-tokens', { ts: startMs + 60_000, aiSessionId: 'ai-act-1' })
            );
            await database.ingestEnvelopeFromSpool(
                aiSessionEnvelope('env-act-end', 'ai.session.ended', 'ai-act-1', {
                    ts: startMs + 90_000,
                    startedAt,
                    endedAt: new Date(startMs + 90_000).toISOString()
                })
            );

            // Act
            const rows = await database.listAiActivityByDay();

            // Assert
            assert.strictEqual(rows.length, 1);
            assert.deepStrictEqual(rows[0], {
                day: localDay(startMs),
                tool: 'claude-code',
                runMs: 90_000,
                activeMs: 60_000,
                sessions: 1,
                inputTokens: 100,
                outputTokens: 50
            });
        });

        it('uses a whole local boundary day for run time and tokens', async () => {
            // Arrange: with days=1 and a fake local 18:00 "now", the raw
            // 24-hour lower bound would be yesterday at 18:00. The active
            // bucket and token row are earlier on that same local day, so run
            // time and tokens must use the snapped local midnight lower bound.
            const realDateNow = Date.now;
            const nowDate = new Date(realDateNow());
            const fakeNowMs = new Date(
                nowDate.getFullYear(),
                nowDate.getMonth(),
                nowDate.getDate(),
                18
            ).getTime();
            Date.now = () => fakeNowMs;
            try {
                const boundaryDayStartMs = new Date(
                    nowDate.getFullYear(),
                    nowDate.getMonth(),
                    nowDate.getDate() - 1
                ).getTime();
                const startMs = boundaryDayStartMs + 12 * HOUR_MS;
                const activeSeconds = 6 * 60 * 60 + 30;
                await database.insertAiSession({
                    id: 'ai-boundary-window',
                    session_id: null,
                    scanner_id: 'scn.test',
                    tool: 'claude-code',
                    model: null,
                    started_at: new Date(startMs).toISOString(),
                    ended_at: null,
                    confidence: 0.9,
                    source: 'process'
                });
                const internals = database as unknown as DatabaseInternals;
                await internals.run(
                    `
                        INSERT INTO ai_activity_daily (ai_session_id, day, active_seconds)
                        VALUES (?, ?, ?)
                    `,
                    ['ai-boundary-window', localDay(startMs), activeSeconds]
                );
                await internals.run(
                    `
                        UPDATE ai_sessions
                        SET active_duration = ?, last_activity_at = ?
                        WHERE id = ?
                    `,
                    [
                        activeSeconds,
                        new Date(startMs + activeSeconds * 1000).toISOString(),
                        'ai-boundary-window'
                    ]
                );
                await database.insertAiTokenUsage({
                    ai_session_id: 'ai-boundary-window',
                    model: 'model-a',
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                    estimated: 0,
                    recorded_at: new Date(startMs + HOUR_MS).toISOString(),
                    envelope_id: 'env-boundary-window-token'
                });

                // Act
                const rows = await database.listAiActivityByDay({ days: 1 });

                // Assert
                const boundary = rows.find(row => row.day === localDay(startMs));
                assert.ok(boundary, 'missing whole boundary day row');
                assert.strictEqual(boundary.runMs, 12 * HOUR_MS);
                assert.strictEqual(boundary.activeMs, activeSeconds * 1000);
                assert.ok(
                    boundary.activeMs <= boundary.runMs,
                    `activeMs ${boundary.activeMs} must not exceed runMs ${boundary.runMs}`
                );
                assert.strictEqual(boundary.inputTokens, 100);
                assert.strictEqual(boundary.outputTokens, 50);
            } finally {
                Date.now = realDateNow;
            }
        });

        it('clamps the day window like listSessions (default 7, max 90, floor 1)', async () => {
            // Arrange: one session 10 days ago, one 2 hours ago.
            const oldStart = Date.now() - 10 * 24 * 60 * 60_000;
            const recentStart = Date.now() - 2 * 60 * 60_000;
            await database.ingestEnvelopeFromSpool(
                aiSessionEnvelope('env-old-start', 'ai.session.started', 'ai-old', {
                    ts: oldStart,
                    tool: 'codex'
                })
            );
            await database.ingestEnvelopeFromSpool(
                aiSessionEnvelope('env-old-end', 'ai.session.ended', 'ai-old', {
                    ts: oldStart,
                    tool: 'codex',
                    endedAt: new Date(oldStart + 60_000).toISOString()
                })
            );
            await database.ingestEnvelopeFromSpool(
                toolDetectedEnvelope('env-recent', { ts: recentStart })
            );

            // Act
            const defaultWindow = await database.listAiActivityByDay();
            const wideWindow = await database.listAiActivityByDay({ days: 5000 });
            const floorWindow = await database.listAiActivityByDay({ days: 0 });

            // Assert: default 7 days excludes the 10-day-old session; the
            // oversized request clamps to 90 days and includes it; days=0
            // floors to 1 day and still sees the recent session. Tools are
            // deduped — the open recent session may split across two day rows
            // when the suite runs shortly after local midnight.
            const uniqueTools = (rows: { tool: string }[]): string[] =>
                [...new Set(rows.map(row => row.tool))].sort();
            assert.deepStrictEqual(uniqueTools(defaultWindow), ['claude-code']);
            assert.deepStrictEqual(uniqueTools(wideWindow), ['claude-code', 'codex']);
            assert.deepStrictEqual(uniqueTools(floorWindow), ['claude-code']);
        });

        it('floors a backdated detection started_at so run time cannot be inflated', async () => {
            // Arrange: a detected envelope with a ts 90 days in the past. The
            // session has no end event, so run_ms is computed up to now.
            const backdated = Date.now() - 90 * 24 * 60 * 60_000;
            await database.ingestEnvelopeFromSpool(
                toolDetectedEnvelope('env-backdated', { ts: backdated })
            );

            // Assert: started_at is floored to within the last few hours, not 90
            // days ago, so the open session reports hours of run time, not days.
            const session = await database.getAiSession('env-backdated');
            assert.ok(session);
            const startedMs = Date.parse(session.started_at);
            const ageMs = Date.now() - startedMs;
            assert.ok(
                ageMs <= 4 * 60 * 60_000 + 60_000,
                `started_at should be floored to ~4h, was ${ageMs}ms old`
            );

            // The activity row for the floored day must report run time well
            // under the per-session DAY_MS cap (and nowhere near 90 days).
            const rows = await database.listAiActivityByDay();
            const total = rows.reduce((sum, row) => sum + row.runMs, 0);
            assert.ok(total <= 24 * 60 * 60_000, `run_ms ${total} must not exceed one day`);
        });

        it('splits a long open session across local days, each bounded by the day length', async () => {
            // Arrange: an open session started ~36 hours ago (no end event).
            const startMs = Date.now() - 36 * 60 * 60_000;
            await database.insertAiSession({
                id: 'ai-long-open',
                session_id: null,
                scanner_id: 'scn.test',
                tool: 'claude-code',
                model: null,
                started_at: new Date(startMs).toISOString(),
                ended_at: null,
                confidence: 0.9,
                source: 'process'
            });

            // Act: query a wide enough window to include the start day.
            const rows = await database.listAiActivityByDay({ days: 5 });

            // Assert: run time is split per local day — no day row exceeds
            // 24h, the session counts on each day it touches, and the total
            // equals the real ~36h wall clock instead of a 24h cap.
            assert.ok(rows.length >= 2, `expected at least two day rows, got ${rows.length}`);
            for (const row of rows) {
                assert.ok(
                    row.runMs <= 24 * 60 * 60_000,
                    `day ${row.day} reports ${row.runMs}ms run time (> 24h)`
                );
                assert.strictEqual(row.sessions, 1);
            }
            const totalRunMs = rows.reduce((sum, row) => sum + row.runMs, 0);
            assert.ok(
                Math.abs(totalRunMs - 36 * 60 * 60_000) < 5_000,
                `expected ~36h total run time, got ${totalRunMs}ms`
            );
        });

        it('splits a session straddling local midnight across both days', async () => {
            // Arrange: one hour on each side of yesterday's local midnight —
            // fully in the past, deterministic regardless of when this runs.
            const now = new Date();
            const midnightMs = new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate() - 1
            ).getTime();
            const startMs = midnightMs - 60 * 60_000;
            const endMs = midnightMs + 60 * 60_000;
            await database.insertAiSession({
                id: 'ai-straddle',
                session_id: null,
                scanner_id: 'scn.test',
                tool: 'claude-code',
                model: null,
                started_at: new Date(startMs).toISOString(),
                ended_at: new Date(endMs).toISOString(),
                confidence: 0.9,
                source: 'process'
            });

            // Act
            const rows = await database.listAiActivityByDay();

            // Assert: one hour of run time lands on each local day, and the
            // session counts toward both days it overlaps.
            const before = rows.find(row => row.day === localDay(startMs));
            const after = rows.find(row => row.day === localDay(endMs));
            assert.ok(before, 'missing day row before midnight');
            assert.ok(after, 'missing day row after midnight');
            assert.strictEqual(before.runMs, 60 * 60_000);
            assert.strictEqual(after.runMs, 60 * 60_000);
            assert.strictEqual(before.sessions, 1);
            assert.strictEqual(after.sessions, 1);
        });

        it('credits each day exactly for a still-running overnight session', async () => {
            // Arrange: a session opened an hour before TODAY's local midnight
            // that is still active now — yesterday must keep only its own
            // portion and today must show the rest instead of zero.
            const nowMs = Date.now();
            const today = new Date(nowMs);
            const midnightMs = new Date(
                today.getFullYear(),
                today.getMonth(),
                today.getDate()
            ).getTime();
            const startMs = midnightMs - 60 * 60_000;
            // Keep the 30s isolated tokens grant fully inside today even when
            // the suite runs within 30s after local midnight.
            const tokensTs = Math.max(nowMs, midnightMs + 30_000);
            await database.ingestEnvelopeFromSpool(
                aiSessionEnvelope('env-overnight-start', 'ai.session.started', 'ai-overnight', {
                    ts: startMs
                })
            );
            await database.ingestEnvelopeFromSpool(
                tokensEnvelope('env-overnight-tok', { ts: tokensTs, aiSessionId: 'ai-overnight' })
            );

            // Act
            const rows = await database.listAiActivityByDay();

            // Assert: yesterday holds exactly its pre-midnight hour; today
            // holds the open remainder (midnight → now). Active time buckets
            // exactly per day: the start event cannot credit pre-start time
            // (yesterday), while the 30s isolated tokens grant ends at
            // tokensTs (today).
            const yesterday = rows.find(row => row.day === localDay(startMs));
            const todayRow = rows.find(row => row.day === localDay(midnightMs));
            assert.ok(yesterday, 'missing day row for the session start day');
            assert.ok(todayRow, 'missing day row for today');
            assert.strictEqual(yesterday.runMs, 60 * 60_000);
            assert.ok(
                Math.abs(todayRow.runMs - (nowMs - midnightMs)) < 5_000,
                `today should hold the post-midnight remainder, got ${todayRow.runMs}ms`
            );
            assert.strictEqual(yesterday.activeMs, 0);
            assert.strictEqual(todayRow.activeMs, 30_000);
        });
    });

    describe('daemon restart backdating', () => {
        it('clamps an etime-backdated start to the swept previous session end (no overlap)', async () => {
            // Arrange: a tool session whose last activity was 30 minutes ago;
            // the daemon dies, restarts, and its startup sweep closes the row
            // at that last activity.
            const nowMs = Date.now();
            const lastActivityMs = nowMs - 30 * 60_000;
            await database.ingestEnvelopeFromSpool(
                toolDetectedEnvelope('env-prev', { ts: lastActivityMs })
            );
            await database.endStaleAiSessions(10);
            const previous = await database.getAiSession('env-prev');
            assert.ok(previous);
            assert.strictEqual(previous.ended_at, new Date(lastActivityMs).toISOString());

            // Act: the process watcher re-detects the still-running tool and
            // backdates the new session via etime to the full process uptime
            // — an hour ago, overlapping the span the old session already
            // counted.
            await database.ingestEnvelopeFromSpool(
                aiSessionEnvelope('env-restart', 'ai.session.started', 'ai-restart', {
                    ts: nowMs,
                    startedAt: new Date(nowMs - 60 * 60_000).toISOString()
                })
            );

            // Assert: the new session starts where the old one ended — no
            // overlap, so the pre-outage span is never counted twice.
            const restarted = await database.getAiSession('ai-restart');
            assert.ok(restarted);
            assert.strictEqual(restarted.started_at, previous.ended_at);

            // Total run across all rows covers the outage exactly once: ~30
            // minutes from the clamped open session (the swept session closed
            // at its own start, contributing zero).
            const rows = await database.listAiActivityByDay();
            const totalRunMs = rows.reduce((sum, row) => sum + row.runMs, 0);
            assert.ok(
                Math.abs(totalRunMs - 30 * 60_000) < 5_000,
                `expected ~30min total run time, got ${totalRunMs}ms`
            );
        });

        it('keeps a backdated start that does not overlap the previous session', async () => {
            // Arrange: previous session swept closed 30 minutes ago.
            const nowMs = Date.now();
            await database.ingestEnvelopeFromSpool(
                toolDetectedEnvelope('env-prev', { ts: nowMs - 30 * 60_000 })
            );
            await database.endStaleAiSessions(10);

            // Act: a new session backdated to AFTER that end (10 minutes ago).
            const startedAt = new Date(nowMs - 10 * 60_000).toISOString();
            await database.ingestEnvelopeFromSpool(
                aiSessionEnvelope('env-next', 'ai.session.started', 'ai-next', {
                    ts: nowMs,
                    startedAt
                })
            );

            // Assert: non-overlapping backdates pass through unclamped.
            const next = await database.getAiSession('ai-next');
            assert.ok(next);
            assert.strictEqual(next.started_at, startedAt);
        });
    });

    describe('detection source labeling', () => {
        it('labels process-evidence detections as source=process', async () => {
            await database.ingestEnvelopeFromSpool(
                toolDetectedEnvelope('env-src-proc', { evidenceType: 'process' })
            );

            const session = await database.getAiSession('env-src-proc');
            assert.ok(session);
            assert.strictEqual(session.source, 'process');
        });

        it('keeps hook-evidence detections labeled source=hook', async () => {
            await database.ingestEnvelopeFromSpool(
                toolDetectedEnvelope('env-src-hook', {
                    evidenceType: 'hook_event',
                    tool: 'codex',
                    scannerId: 'scn.codex'
                })
            );

            const session = await database.getAiSession('env-src-hook');
            assert.ok(session);
            assert.strictEqual(session.source, 'hook');
        });

        it('labels terminal-evidence detections from vscode as source=terminal', async () => {
            await database.ingestEnvelopeFromSpool(
                toolDetectedEnvelope('env-src-term', {
                    evidenceType: 'terminal',
                    src: 'vscode',
                    tool: 'droid',
                    scannerId: 'scn.droid'
                })
            );

            const session = await database.getAiSession('env-src-term');
            assert.ok(session);
            assert.strictEqual(session.source, 'terminal');
        });
    });

    describe('ai.session.started dedup', () => {
        it('does not open a second session for a scanner+tool that is already active', async () => {
            // Arrange
            await database.ingestEnvelopeFromSpool(
                aiSessionEnvelope('env-dedup-1', 'ai.session.started', 'ai-dedup-1')
            );

            // Act: a second started envelope for the same scanner+tool
            const second = await database.ingestEnvelopeFromSpool(
                aiSessionEnvelope('env-dedup-2', 'ai.session.started', 'ai-dedup-2', {
                    ts: TS + 5_000
                })
            );

            // Assert
            assert.strictEqual(second, false);
            assert.strictEqual(await database.getAiSession('ai-dedup-2'), null);
            const sessions = await database.listAiSessions();
            assert.strictEqual(sessions.filter(row => row.tool === 'claude-code').length, 1);
        });
    });
});
