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

function codingSessionEnvelope(
    id: string,
    sessionId: string,
    startMs: number,
    options: { type?: 'session.updated' | 'session.ended'; endMs?: number; project?: string } = {}
): AnyEnvelope {
    const type = options.type ?? 'session.updated';
    return {
        v: ENVELOPE_VERSION,
        id,
        ts: startMs,
        src: 'vscode',
        type,
        payload: {
            type,
            session: {
                id: sessionId,
                startTime: new Date(startMs).toISOString(),
                endTime: options.endMs ? new Date(options.endMs).toISOString() : undefined,
                duration: 120,
                idleDuration: 10,
                project: options.project ?? 'code-pulse',
                language: 'typescript',
                file: 'src/app.ts',
                branch: 'main',
                isActive: type === 'session.updated',
                heartbeats: 5,
                keystrokes: 100,
                linesAdded: 10,
                linesRemoved: 2,
                tags: ['focus']
            }
        }
    };
}

describe('GET /v1/sessions', () => {
    let tempDir = '';
    let database: DatabaseV5;
    let server: InstanceType<typeof DaemonHttpServer>;
    let port = 0;

    const now = Date.now();
    const recentStart = now - HOUR_MS;
    const midStart = now - 2 * DAY_MS;
    const oldStart = now - 200 * DAY_MS;

    before(async () => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-sessions-'));
        database = new DatabaseV5(tempDir);
        await database.open();

        // Three coding sessions: one fresh, one inside the default 7-day
        // window, one far outside even the 90-day clamp ceiling.
        await database.ingestEnvelopeFromSpool(
            codingSessionEnvelope('env-recent', 'cs-recent', recentStart, { project: 'fresh' })
        );
        await database.ingestEnvelopeFromSpool(
            codingSessionEnvelope('env-mid', 'cs-mid', midStart, {
                type: 'session.ended',
                endMs: midStart + HOUR_MS
            })
        );
        await database.ingestEnvelopeFromSpool(
            codingSessionEnvelope('env-old', 'cs-old', oldStart, {
                type: 'session.ended',
                endMs: oldStart + HOUR_MS
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
        const response = await request(port, '/v1/sessions');

        assert.strictEqual(response.status, 401);
        assert.strictEqual(response.body.success, false);
    });

    it('returns sessions in the default window newest-first with a token', async () => {
        const response = await request(port, '/v1/sessions', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.success, true);

        const sessions = response.body.data.sessions;
        assert.strictEqual(response.body.data.total, 2);
        assert.deepStrictEqual(
            sessions.map((row: { id: string }) => row.id),
            ['cs-recent', 'cs-mid']
        );

        const newest = sessions[0];
        assert.strictEqual(newest.project, 'fresh');
        assert.strictEqual(newest.startTime, new Date(recentStart).toISOString());
        assert.strictEqual(newest.isActive, true);
        assert.strictEqual(newest.duration, 120);
        assert.strictEqual(newest.language, 'typescript');
        assert.deepStrictEqual(newest.tags, ['focus']);

        const ended = sessions[1];
        assert.strictEqual(ended.isActive, false);
        assert.strictEqual(ended.endTime, new Date(midStart + HOUR_MS).toISOString());
    });

    it('clamps oversized days/limit — 200-day-old session stays excluded', async () => {
        const response = await request(port, '/v1/sessions?days=100000&limit=999999', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(
            response.body.data.sessions.map((row: { id: string }) => row.id),
            ['cs-recent', 'cs-mid']
        );
    });

    it('clamps negative days/limit to the minimum instead of erroring', async () => {
        const response = await request(port, '/v1/sessions?days=-5&limit=-3', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });

        assert.strictEqual(response.status, 200);
        // days floors to 1 (only the fresh session) and limit floors to 1.
        assert.deepStrictEqual(
            response.body.data.sessions.map((row: { id: string }) => row.id),
            ['cs-recent']
        );
    });

    it('respects an explicit small limit', async () => {
        const response = await request(port, '/v1/sessions?days=30&limit=1', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.data.sessions.length, 1);
        assert.strictEqual(response.body.data.sessions[0].id, 'cs-recent');
    });

    it('lists /v1/sessions in the capabilities endpoints', async () => {
        const response = await request(port, '/v1/capabilities', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });

        assert.strictEqual(response.status, 200);
        assert.ok(response.body.data.http.endpoints.includes('/v1/sessions'));
    });
});
