import assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as nodePath from 'path';
import { DatabaseV5 } from '@codepulse/core';
import { ENVELOPE_VERSION, type AnyEnvelope } from '@codepulse/protocol';

// Compiled daemon http server — import via relative path to dist for tests
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DaemonHttpServer } = require('../../../apps/daemon/dist/http/server.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MetricsRegistry } = require('../../../apps/daemon/dist/metrics.js');

const AUTH_TOKEN = 'test-token-0123456789';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface HttpResponse {
    status: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: { success?: boolean; data?: any; error?: string };
    raw: string;
}

function request(
    port: number,
    requestPath: string,
    headers: Record<string, string> = {}
): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: requestPath,
                method: 'GET',
                setHost: false,
                headers: { Host: `127.0.0.1:${port}`, ...headers }
            },
            res => {
                const chunks: Buffer[] = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let body: unknown = {};
                    try {
                        body = JSON.parse(raw);
                    } catch {
                        body = {};
                    }
                    resolve({ status: res.statusCode ?? 0, body, raw } as HttpResponse);
                });
            }
        );
        req.on('error', reject);
        req.end();
    });
}

function aiSessionEnvelope(
    id: string,
    type: 'ai.session.started' | 'ai.session.ended',
    aiSessionId: string,
    options: { ts: number; tool?: string; scannerId?: string; endedAt?: string }
): AnyEnvelope {
    return {
        v: ENVELOPE_VERSION,
        id,
        ts: options.ts,
        src: 'scanner',
        type,
        payload: {
            type,
            aiSession: {
                id: aiSessionId,
                scannerId: options.scannerId ?? 'scn.test',
                tool: options.tool ?? 'claude-code',
                startedAt: new Date(options.ts).toISOString(),
                endedAt: options.endedAt,
                confidence: 0.9,
                source: 'process'
            }
        }
    };
}

function tokensEnvelope(
    id: string,
    options: { ts: number; aiSessionId: string; tool?: string }
): AnyEnvelope {
    return {
        v: ENVELOPE_VERSION,
        id,
        ts: options.ts,
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

describe('GET /v1/ai/activity', () => {
    let tempDir = '';
    let database: DatabaseV5;
    let server: InstanceType<typeof DaemonHttpServer>;
    let port = 0;

    const now = Date.now();
    // Anchor the recent fixture ~2h back, clamped at least 10 minutes away
    // from both local midnights of its day — the 90s session and its 60s
    // active gap must stay inside ONE local day, or it would split into two
    // day rows when the suite runs within a couple of hours after midnight.
    const rawRecentStart = now - 2 * HOUR_MS;
    const rawRecentDate = new Date(rawRecentStart);
    const recentDayStartMs = new Date(
        rawRecentDate.getFullYear(),
        rawRecentDate.getMonth(),
        rawRecentDate.getDate()
    ).getTime();
    const recentStart = Math.min(
        Math.max(rawRecentStart, recentDayStartMs + 10 * 60_000),
        recentDayStartMs + DAY_MS - 10 * 60_000
    );
    // Anchor the old fixture at local noon 10 days ago so its 60s session can
    // never straddle a midnight either (still outside the default 7-day
    // window and inside the 90-day clamp ceiling).
    const nowDate = new Date(now);
    const oldStart = new Date(
        nowDate.getFullYear(),
        nowDate.getMonth(),
        nowDate.getDate() - 10,
        12
    ).getTime();

    before(async () => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-ai-activity-http-'));
        database = new DatabaseV5(tempDir);
        await database.open();

        // Recent: a 90s claude-code session (2h ago) with one tokens event.
        // The start observation credits no pre-start active time, so active
        // duration is the 60s gap to the tokens event.
        await database.ingestEnvelopeFromSpool(
            aiSessionEnvelope('env-recent-start', 'ai.session.started', 'ai-recent', {
                ts: recentStart
            })
        );
        await database.ingestEnvelopeFromSpool(
            tokensEnvelope('env-recent-tokens', {
                ts: recentStart + 60_000,
                aiSessionId: 'ai-recent'
            })
        );
        await database.ingestEnvelopeFromSpool(
            aiSessionEnvelope('env-recent-end', 'ai.session.ended', 'ai-recent', {
                ts: recentStart,
                endedAt: new Date(recentStart + 90_000).toISOString()
            })
        );

        // Old: a closed codex session 10 days ago — outside the default
        // 7-day window but inside the 90-day clamp ceiling.
        await database.ingestEnvelopeFromSpool(
            aiSessionEnvelope('env-old-start', 'ai.session.started', 'ai-old', {
                ts: oldStart,
                tool: 'codex',
                scannerId: 'scn.codex'
            })
        );
        await database.ingestEnvelopeFromSpool(
            aiSessionEnvelope('env-old-end', 'ai.session.ended', 'ai-old', {
                ts: oldStart,
                tool: 'codex',
                scannerId: 'scn.codex',
                endedAt: new Date(oldStart + 60_000).toISOString()
            })
        );

        const config = {
            dataDir: tempDir,
            // Ephemeral port — the OS picks a free one; never the real 7842/7843.
            httpPort: 0,
            wsPort: 0,
            host: '127.0.0.1',
            spoolPath: nodePath.join(tempDir, 'spool', 'events.ndjson'),
            spoolCursorPath: nodePath.join(tempDir, 'spool', 'cursor.json'),
            registryDir: nodePath.join(tempDir, 'registry'),
            tokenPath: nodePath.join(tempDir, 'token'),
            pidPath: nodePath.join(tempDir, 'daemon.pid'),
            portFilePath: nodePath.join(tempDir, 'ports.json'),
            legacyPortFilePath: nodePath.join(tempDir, 'port')
        };

        server = new DaemonHttpServer({
            config,
            metrics: new MetricsRegistry(),
            wsBroadcaster: { getConnectedClients: () => 0 },
            spoolTailer: {
                getSpoolPath: () => config.spoolPath,
                getOffset: () => 0
            },
            snapshotManager: {
                listSnapshots: async () => []
            },
            database,
            startedAt: new Date(),
            authToken: AUTH_TOKEN
        });
        await server.start();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        port = (server as any).server.address().port;
        assert.ok(port > 0);
        assert.notStrictEqual(port, 7842);
        assert.notStrictEqual(port, 7843);
    });

    after(async () => {
        if (server) {
            await server.stop();
        }
        if (database) {
            await database.close();
        }
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects requests without a token with 401', async () => {
        const response = await request(port, '/v1/ai/activity');

        assert.strictEqual(response.status, 401);
        assert.strictEqual(response.body.success, false);
    });

    it('returns {activity, total} day×tool aggregates with a token', async () => {
        const response = await request(port, '/v1/ai/activity', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.success, true);

        const { activity, total } = response.body.data;
        assert.strictEqual(total, activity.length);
        // Default 7-day window: only the recent claude-code session.
        assert.strictEqual(activity.length, 1);
        const row = activity[0];
        assert.strictEqual(row.tool, 'claude-code');
        assert.strictEqual(row.runMs, 90_000);
        assert.strictEqual(row.activeMs, 60_000);
        assert.strictEqual(row.sessions, 1);
        assert.strictEqual(row.inputTokens, 100);
        assert.strictEqual(row.outputTokens, 50);
        assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);
    });

    it('clamps oversized days to 90 — the 10-day-old session appears', async () => {
        const response = await request(port, '/v1/ai/activity?days=100000', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });

        assert.strictEqual(response.status, 200);
        const tools = response.body.data.activity
            .map((row: { tool: string }) => row.tool)
            .sort();
        assert.deepStrictEqual(tools, ['claude-code', 'codex']);
        assert.strictEqual(response.body.data.total, 2);
    });

    it('floors days=0 to a 1-day window instead of erroring', async () => {
        const response = await request(port, '/v1/ai/activity?days=0', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(
            response.body.data.activity.map((row: { tool: string }) => row.tool),
            ['claude-code']
        );
    });

    it('lists /v1/ai/activity in the capabilities endpoints', async () => {
        const response = await request(port, '/v1/capabilities', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });

        assert.strictEqual(response.status, 200);
        assert.ok(response.body.data.http.endpoints.includes('/v1/ai/activity'));
    });

    it('exposes activeDurationMs/lastActivityAt/isActive on /v1/ai/sessions', async () => {
        const response = await request(port, '/v1/ai/sessions?limit=999999', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });

        assert.strictEqual(response.status, 200);
        const sessions = response.body.data.sessions;
        assert.strictEqual(response.body.data.total, 2);

        const recent = sessions.find((row: { id: string }) => row.id === 'ai-recent');
        assert.ok(recent);
        assert.strictEqual(recent.durationMs, 90_000);
        assert.strictEqual(recent.activeDurationMs, 60_000);
        assert.strictEqual(recent.lastActivityAt, new Date(recentStart + 60_000).toISOString());
        assert.strictEqual(recent.isActive, false);
        assert.strictEqual(recent.inputTokens, 100);
        assert.strictEqual(recent.outputTokens, 50);

        const old = sessions.find((row: { id: string }) => row.id === 'ai-old');
        assert.ok(old);
        assert.strictEqual(old.isActive, false);
        assert.strictEqual(old.inputTokens, 0);
        assert.strictEqual(old.outputTokens, 0);
    });
});
