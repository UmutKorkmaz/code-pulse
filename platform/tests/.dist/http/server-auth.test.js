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
const http = __importStar(require("http"));
const os = __importStar(require("os"));
const nodePath = __importStar(require("path"));
// Compiled daemon http server — import via relative path to dist for tests
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DaemonHttpServer } = require('../../../apps/daemon/dist/http/server.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MetricsRegistry } = require('../../../apps/daemon/dist/metrics.js');
const AUTH_TOKEN = 'test-token-0123456789';
function request(port, requestPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: requestPath,
            method: 'GET',
            setHost: false,
            headers: { Host: `127.0.0.1:${port}`, ...headers }
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let body = {};
                try {
                    body = JSON.parse(raw);
                }
                catch {
                    body = {};
                }
                resolve({ status: res.statusCode ?? 0, body, raw });
            });
        });
        req.on('error', reject);
        req.end();
    });
}
describe('daemon http auth', () => {
    let tempDir = '';
    let server;
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
        port = server.server.address().port;
        assert_1.default.ok(port > 0);
        assert_1.default.notStrictEqual(port, 7842);
        assert_1.default.notStrictEqual(port, 7843);
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
        assert_1.default.strictEqual(status.status, 401);
        assert_1.default.strictEqual(status.body.success, false);
        assert_1.default.strictEqual(sessions.status, 401);
    });
    it('accepts a valid Bearer token on protected routes', async () => {
        const response = await request(port, '/v1/status', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });
        assert_1.default.strictEqual(response.status, 200);
        assert_1.default.strictEqual(response.body.success, true);
        assert_1.default.strictEqual(response.body.data.service, 'codepulse-d');
    });
    it('accepts the token via the ?token= query parameter', async () => {
        const response = await request(port, `/v1/status?token=${AUTH_TOKEN}`);
        assert_1.default.strictEqual(response.status, 200);
        assert_1.default.strictEqual(response.body.success, true);
    });
    it('rejects wrong tokens via header and query', async () => {
        const viaHeader = await request(port, '/v1/status', {
            Authorization: 'Bearer wrong-token'
        });
        const viaQuery = await request(port, '/v1/status?token=wrong-token');
        assert_1.default.strictEqual(viaHeader.status, 401);
        assert_1.default.strictEqual(viaQuery.status, 401);
    });
    it('serves health, metrics, and bootstrap without authentication', async () => {
        const health = await request(port, '/v1/health');
        const metrics = await request(port, '/v1/metrics');
        const bootstrap = await request(port, '/v1/bootstrap');
        assert_1.default.strictEqual(health.status, 200);
        assert_1.default.strictEqual(health.body.data.status, 'healthy');
        assert_1.default.strictEqual(metrics.status, 200);
        assert_1.default.ok(metrics.raw.includes('codepulse_http_requests_total'));
        assert_1.default.strictEqual(bootstrap.status, 200);
    });
    it('omits the token from bootstrap when no Origin is sent', async () => {
        const response = await request(port, '/v1/bootstrap');
        assert_1.default.strictEqual(response.status, 200);
        assert_1.default.strictEqual(response.body.data.token, undefined);
        assert_1.default.ok(!response.raw.includes(AUTH_TOKEN));
        assert_1.default.deepStrictEqual(response.body.data.ports, { http: 0, ws: 0 });
    });
    it('returns the token from bootstrap to the trusted Tauri origin', async () => {
        const response = await request(port, '/v1/bootstrap', {
            Origin: 'tauri://localhost'
        });
        assert_1.default.strictEqual(response.status, 200);
        assert_1.default.strictEqual(response.body.data.token, AUTH_TOKEN);
    });
    it('rejects a non-loopback Host header with 403 on every route', async () => {
        const health = await request(port, '/v1/health', { Host: 'evil.example.com' });
        const bootstrap = await request(port, '/v1/bootstrap', { Host: 'evil.example.com:7842' });
        const status = await request(port, '/v1/status', {
            Host: 'evil.example.com',
            Authorization: `Bearer ${AUTH_TOKEN}`
        });
        assert_1.default.strictEqual(health.status, 403);
        assert_1.default.strictEqual(bootstrap.status, 403);
        assert_1.default.strictEqual(status.status, 403);
    });
});
