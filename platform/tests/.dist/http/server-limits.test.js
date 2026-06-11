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
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const AI_TOKENS_MAX_DAYS = 90;
/**
 * POST a body to the daemon as a manually-fed stream so the test controls how
 * many bytes are sent and can observe the server tearing the socket down once
 * the cap is exceeded. `onBytesWritten` reports how much actually reached the
 * wire — used to prove the daemon stops the writer rather than buffering it all.
 */
function postStream(port, requestPath, totalBytes, headers = {}) {
    return new Promise(resolve => {
        const chunk = Buffer.alloc(64 * 1024, 0x20); // 64 KiB of spaces
        let bytesWritten = 0;
        let aborted = false;
        let settled = false;
        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(result);
        };
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: requestPath,
            method: 'POST',
            setHost: false,
            headers: {
                Host: `127.0.0.1:${port}`,
                'Content-Type': 'application/json',
                Authorization: `Bearer ${AUTH_TOKEN}`,
                ...headers
            }
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let body = {};
                try {
                    body = JSON.parse(raw);
                }
                catch {
                    body = {};
                }
                finish({
                    response: { status: res.statusCode ?? 0, body, raw },
                    bytesWritten,
                    aborted
                });
            });
        });
        // The daemon destroys the request stream once the cap trips; the writer
        // then sees ECONNRESET / EPIPE. That is the expected DoS-defense signal,
        // not a test failure.
        req.on('error', () => {
            aborted = true;
            finish({ bytesWritten, aborted });
        });
        const writeNext = () => {
            if (settled) {
                return;
            }
            if (bytesWritten >= totalBytes) {
                req.end();
                return;
            }
            const remaining = totalBytes - bytesWritten;
            const slice = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
            bytesWritten += slice.length;
            const canContinue = req.write(slice);
            if (canContinue) {
                setImmediate(writeNext);
            }
            else {
                req.once('drain', writeNext);
            }
        };
        // Open the body shaped like valid ingest JSON so a non-oversized body
        // would parse cleanly; only the size, not the shape, drives the 413.
        writeNext();
    });
}
describe('daemon http request limits', () => {
    let tempDir = '';
    let server;
    let port = 0;
    let aggregateCalls = 0;
    before(async () => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-http-limits-'));
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
                // Count fan-out so the clamp can be proven by call count.
                aggregateTokenUsageByDay: async () => {
                    aggregateCalls += 1;
                    return [];
                },
                ingestEnvelopeFromSpool: async () => true
            },
            startedAt: new Date(),
            authToken: AUTH_TOKEN
        });
        await server.start();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    it('accepts a small POST body to /v1/events/ingest with 200', async () => {
        const { response } = await postStream(port, '/v1/events/ingest', 256);
        assert_1.default.ok(response);
        assert_1.default.strictEqual(response.status, 200);
        assert_1.default.strictEqual(response.body.success, true);
    });
    it('rejects an oversized POST body with 413 without buffering it all', async () => {
        // Try to push ~16 MiB through an 8 MiB cap.
        const oversized = 2 * MAX_REQUEST_BODY_BYTES;
        const { response, bytesWritten, aborted } = await postStream(port, '/v1/events/ingest', oversized);
        // The daemon tears the stream down at the cap: either we got an explicit
        // 413 back, or the socket was reset mid-write (also a valid defense).
        if (response) {
            assert_1.default.strictEqual(response.status, 413);
            assert_1.default.strictEqual(response.body.success, false);
        }
        else {
            assert_1.default.strictEqual(aborted, true);
        }
        // The writer must NOT have managed to push the whole oversized payload —
        // proving the server stopped reading well before the full body landed.
        assert_1.default.ok(bytesWritten < oversized, `expected the daemon to abort before ${oversized} bytes, wrote ${bytesWritten}`);
        // Generous upper bound: the client can push the cap plus whatever the
        // kernel/Node socket send+receive buffers hold in flight before the
        // server's destroy() backpressures the write — that in-flight amount is
        // OS-dependent and non-deterministic, so we only require that the writer
        // stalled well short of the full payload (not the whole oversized body),
        // proving the server stopped reading. A tighter bound here races buffering.
        assert_1.default.ok(bytesWritten <= MAX_REQUEST_BODY_BYTES + 4 * 1024 * 1024, `expected the writer to stall near the ${MAX_REQUEST_BODY_BYTES}-byte cap, wrote ${bytesWritten}`);
    });
    it('clamps /v1/ai/tokens days to 90 so it cannot fan out unbounded queries', async () => {
        aggregateCalls = 0;
        const response = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port,
                path: '/v1/ai/tokens?days=100000&day=2026-06-11',
                method: 'GET',
                setHost: false,
                headers: {
                    Host: `127.0.0.1:${port}`,
                    Authorization: `Bearer ${AUTH_TOKEN}`
                }
            }, res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
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
        assert_1.default.strictEqual(response.status, 200);
        assert_1.default.strictEqual(response.body.success, true);
        // One per-day query per clamped day — capped at 90, never 100000.
        assert_1.default.strictEqual(aggregateCalls, AI_TOKENS_MAX_DAYS);
    });
});
