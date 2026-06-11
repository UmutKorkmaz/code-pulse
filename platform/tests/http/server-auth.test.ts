import assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as nodePath from 'path';

// Compiled daemon http server — import via relative path to dist for tests
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DaemonHttpServer } = require('../../../apps/daemon/dist/http/server.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MetricsRegistry } = require('../../../apps/daemon/dist/metrics.js');

const AUTH_TOKEN = 'test-token-0123456789';

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

describe('daemon http auth', () => {
    let tempDir = '';
    let server: InstanceType<typeof DaemonHttpServer>;
    let port = 0;

    before(async () => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-http-'));
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
            database: {
                listAiSessions: async () => [],
                listAiTokenUsage: async () => [],
                aggregateTokenUsageByDay: async () => [],
                ingestEnvelopeFromSpool: async () => true
            },
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
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects protected routes without a token with 401', async () => {
        const status = await request(port, '/v1/status');
        const sessions = await request(port, '/v1/ai/sessions');

        assert.strictEqual(status.status, 401);
        assert.strictEqual(status.body.success, false);
        assert.strictEqual(sessions.status, 401);
    });

    it('accepts a valid Bearer token on protected routes', async () => {
        const response = await request(port, '/v1/status', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.success, true);
        assert.strictEqual(response.body.data.service, 'codepulse-d');
    });

    it('accepts the token via the ?token= query parameter', async () => {
        const response = await request(port, `/v1/status?token=${AUTH_TOKEN}`);

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.success, true);
    });

    it('rejects wrong tokens via header and query', async () => {
        const viaHeader = await request(port, '/v1/status', {
            Authorization: 'Bearer wrong-token'
        });
        const viaQuery = await request(port, '/v1/status?token=wrong-token');

        assert.strictEqual(viaHeader.status, 401);
        assert.strictEqual(viaQuery.status, 401);
    });

    it('serves health, metrics, and bootstrap without authentication', async () => {
        const health = await request(port, '/v1/health');
        const metrics = await request(port, '/v1/metrics');
        const bootstrap = await request(port, '/v1/bootstrap');

        assert.strictEqual(health.status, 200);
        assert.strictEqual(health.body.data.status, 'healthy');
        assert.strictEqual(metrics.status, 200);
        assert.ok(metrics.raw.includes('codepulse_http_requests_total'));
        assert.strictEqual(bootstrap.status, 200);
    });

    it('omits the token from bootstrap when no Origin is sent', async () => {
        const response = await request(port, '/v1/bootstrap');

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.data.token, undefined);
        assert.ok(!response.raw.includes(AUTH_TOKEN));
        assert.deepStrictEqual(response.body.data.ports, { http: 0, ws: 0 });
    });

    it('returns the token from bootstrap to the trusted Tauri origin', async () => {
        const response = await request(port, '/v1/bootstrap', {
            Origin: 'tauri://localhost'
        });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.data.token, AUTH_TOKEN);
    });

    it('rejects a non-loopback Host header with 403 on every route', async () => {
        const health = await request(port, '/v1/health', { Host: 'evil.example.com' });
        const bootstrap = await request(port, '/v1/bootstrap', { Host: 'evil.example.com:7842' });
        const status = await request(port, '/v1/status', {
            Host: 'evil.example.com',
            Authorization: `Bearer ${AUTH_TOKEN}`
        });

        assert.strictEqual(health.status, 403);
        assert.strictEqual(bootstrap.status, 403);
        assert.strictEqual(status.status, 403);
    });
});
