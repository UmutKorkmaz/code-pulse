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
const core_1 = require("@codepulse/core");
const protocol_1 = require("@codepulse/protocol");
// Compiled daemon http server — import via relative path to dist for tests
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DaemonHttpServer } = require('../../../apps/daemon/dist/http/server.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MetricsRegistry } = require('../../../apps/daemon/dist/metrics.js');
const AUTH_TOKEN = 'test-token-0123456789';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
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
function codingSessionEnvelope(id, sessionId, startMs, options = {}) {
    const type = options.type ?? 'session.updated';
    return {
        v: protocol_1.ENVELOPE_VERSION,
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
    let database;
    let server;
    let port = 0;
    const now = Date.now();
    const recentStart = now - HOUR_MS;
    const midStart = now - 2 * DAY_MS;
    const oldStart = now - 200 * DAY_MS;
    before(async () => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-sessions-'));
        database = new core_1.DatabaseV5(tempDir);
        await database.open();
        // Three coding sessions: one fresh, one inside the default 7-day
        // window, one far outside even the 90-day clamp ceiling.
        await database.ingestEnvelopeFromSpool(codingSessionEnvelope('env-recent', 'cs-recent', recentStart, { project: 'fresh' }));
        await database.ingestEnvelopeFromSpool(codingSessionEnvelope('env-mid', 'cs-mid', midStart, {
            type: 'session.ended',
            endMs: midStart + HOUR_MS
        }));
        await database.ingestEnvelopeFromSpool(codingSessionEnvelope('env-old', 'cs-old', oldStart, {
            type: 'session.ended',
            endMs: oldStart + HOUR_MS
        }));
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
        port = server.server.address().port;
        assert_1.default.ok(port > 0);
        assert_1.default.notStrictEqual(port, 7842);
        assert_1.default.notStrictEqual(port, 7843);
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
        assert_1.default.strictEqual(response.status, 401);
        assert_1.default.strictEqual(response.body.success, false);
    });
    it('returns sessions in the default window newest-first with a token', async () => {
        const response = await request(port, '/v1/sessions', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });
        assert_1.default.strictEqual(response.status, 200);
        assert_1.default.strictEqual(response.body.success, true);
        const sessions = response.body.data.sessions;
        assert_1.default.strictEqual(response.body.data.total, 2);
        assert_1.default.deepStrictEqual(sessions.map((row) => row.id), ['cs-recent', 'cs-mid']);
        const newest = sessions[0];
        assert_1.default.strictEqual(newest.project, 'fresh');
        assert_1.default.strictEqual(newest.startTime, new Date(recentStart).toISOString());
        assert_1.default.strictEqual(newest.isActive, true);
        assert_1.default.strictEqual(newest.duration, 120);
        assert_1.default.strictEqual(newest.language, 'typescript');
        assert_1.default.deepStrictEqual(newest.tags, ['focus']);
        const ended = sessions[1];
        assert_1.default.strictEqual(ended.isActive, false);
        assert_1.default.strictEqual(ended.endTime, new Date(midStart + HOUR_MS).toISOString());
    });
    it('clamps oversized days/limit — 200-day-old session stays excluded', async () => {
        const response = await request(port, '/v1/sessions?days=100000&limit=999999', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });
        assert_1.default.strictEqual(response.status, 200);
        assert_1.default.deepStrictEqual(response.body.data.sessions.map((row) => row.id), ['cs-recent', 'cs-mid']);
    });
    it('clamps negative days/limit to the minimum instead of erroring', async () => {
        const response = await request(port, '/v1/sessions?days=-5&limit=-3', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });
        assert_1.default.strictEqual(response.status, 200);
        // days floors to 1 (only the fresh session) and limit floors to 1.
        assert_1.default.deepStrictEqual(response.body.data.sessions.map((row) => row.id), ['cs-recent']);
    });
    it('respects an explicit small limit', async () => {
        const response = await request(port, '/v1/sessions?days=30&limit=1', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });
        assert_1.default.strictEqual(response.status, 200);
        assert_1.default.strictEqual(response.body.data.sessions.length, 1);
        assert_1.default.strictEqual(response.body.data.sessions[0].id, 'cs-recent');
    });
    it('lists /v1/sessions in the capabilities endpoints', async () => {
        const response = await request(port, '/v1/capabilities', {
            Authorization: `Bearer ${AUTH_TOKEN}`
        });
        assert_1.default.strictEqual(response.status, 200);
        assert_1.default.ok(response.body.data.http.endpoints.includes('/v1/sessions'));
    });
});
