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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DaemonHttpServer = void 0;
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const protocol_1 = require("@codepulse/protocol");
const core_1 = require("@codepulse/core");
const constants_1 = require("../constants");
const registry_1 = require("../registry");
const cors_1 = require("./cors");
class DaemonHttpServer {
    deps;
    server = null;
    constructor(deps) {
        this.deps = deps;
    }
    async start() {
        if (this.server) {
            return;
        }
        await new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                void this.handleRequest(req, res);
            });
            server.on('error', reject);
            server.listen(this.deps.config.httpPort, this.deps.config.host, () => resolve());
            this.server = server;
        });
    }
    async stop() {
        if (!this.server) {
            return;
        }
        await new Promise((resolve, reject) => {
            this.server.close(error => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
        this.server = null;
    }
    async handleRequest(req, res) {
        const pathname = new URL(req.url ?? '/', `http://${this.deps.config.host}`).pathname;
        this.deps.metrics.increment('codepulse_http_requests_total');
        this.deps.metrics.increment(`codepulse_http_requests_path_${sanitizeMetricName(pathname)}`);
        // DNS-rebinding defense: reject any request whose Host header is not a
        // loopback name/address. Applies to EVERY route, including /v1/health,
        // /v1/metrics, and /v1/bootstrap.
        if (!this.isHostAllowed(req)) {
            this.deps.metrics.increment('codepulse_http_host_rejected_total');
            this.sendJson(res, 403, {
                success: false,
                error: 'Forbidden host',
                timestamp: new Date().toISOString()
            });
            return;
        }
        if (req.method === 'OPTIONS') {
            (0, cors_1.applyCorsHeaders)(req, res);
            res.writeHead(200);
            res.end();
            return;
        }
        if (req.method !== 'GET' && req.method !== 'POST') {
            this.sendJson(res, 405, {
                success: false,
                error: `Method not allowed: ${req.method}`,
                timestamp: new Date().toISOString()
            });
            return;
        }
        try {
            (0, cors_1.applyCorsHeaders)(req, res);
            if (!this.isAuthorized(req)) {
                this.sendJson(res, 401, {
                    success: false,
                    error: 'Unauthorized',
                    timestamp: new Date().toISOString()
                });
                return;
            }
            const restoreMatch = pathname.match(/^\/v1\/snapshots\/([^/]+)\/restore$/);
            if (restoreMatch) {
                await this.handleRestoreSnapshot(req, res, restoreMatch[1]);
                return;
            }
            if (pathname === '/v1/events/ingest' && req.method === 'POST') {
                await this.handleIngestEvents(req, res);
                return;
            }
            if (pathname === '/v1/snapshots') {
                if (req.method === 'GET') {
                    await this.handleListSnapshots(req, res);
                    return;
                }
                if (req.method === 'POST') {
                    await this.handleCreateSnapshot(req, res);
                    return;
                }
            }
            if (req.method !== 'GET') {
                this.sendJson(res, 405, {
                    success: false,
                    error: `Method not allowed: ${req.method}`,
                    timestamp: new Date().toISOString()
                });
                return;
            }
            switch (pathname) {
                case '/v1/health':
                    this.sendJson(res, 200, {
                        success: true,
                        data: {
                            status: 'healthy',
                            tracking: false,
                            database: fs.existsSync(path.join(this.deps.config.dataDir, 'codepulse.db'))
                                ? 'connected'
                                : 'missing',
                            uptime: Date.now() - this.deps.startedAt.getTime(),
                            version: constants_1.DAEMON_VERSION
                        },
                        timestamp: new Date().toISOString()
                    });
                    return;
                case '/v1/status':
                    this.sendJson(res, 200, {
                        success: true,
                        data: {
                            service: 'codepulse-d',
                            version: constants_1.DAEMON_VERSION,
                            protocol: constants_1.PROTOCOL,
                            status: 'running',
                            uptime: Date.now() - this.deps.startedAt.getTime(),
                            startedAt: this.deps.startedAt.toISOString(),
                            connectedClients: this.deps.wsBroadcaster.getConnectedClients(),
                            isTracking: false,
                            dataDir: this.deps.config.dataDir,
                            ports: {
                                http: this.deps.config.httpPort,
                                ws: this.deps.config.wsPort
                            },
                            spool: {
                                path: this.deps.spoolTailer.getSpoolPath(),
                                offset: this.deps.spoolTailer.getOffset()
                            }
                        },
                        timestamp: new Date().toISOString()
                    });
                    return;
                case '/v1/capabilities':
                    this.sendJson(res, 200, {
                        success: true,
                        data: this.buildCapabilities(),
                        timestamp: new Date().toISOString()
                    });
                    return;
                case '/v1/registry':
                    this.sendJson(res, 200, {
                        success: true,
                        data: {
                            scanners: (0, registry_1.loadInstalledScanners)(this.deps.config.registryDir),
                            updatedAt: new Date().toISOString()
                        },
                        timestamp: new Date().toISOString()
                    });
                    return;
                case '/v1/metrics':
                    res.writeHead(200, {
                        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8'
                    });
                    res.end(this.deps.metrics.renderPrometheus());
                    return;
                case '/v1/bootstrap':
                    if (!this.isLocalhost(req)) {
                        this.sendJson(res, 403, {
                            success: false,
                            error: 'Bootstrap is only available from localhost',
                            timestamp: new Date().toISOString()
                        });
                        return;
                    }
                    this.sendJson(res, 200, {
                        success: true,
                        data: {
                            // Only trusted desktop shells receive the bearer token.
                            // Random localhost browser tabs must use VITE_DAEMON_TOKEN.
                            ...(this.isTrustedBootstrapClient(req)
                                ? { token: this.deps.authToken }
                                : {}),
                            ports: {
                                http: this.deps.config.httpPort,
                                ws: this.deps.config.wsPort
                            },
                            host: this.deps.config.host
                        },
                        timestamp: new Date().toISOString()
                    });
                    return;
                case '/v1/sessions':
                    await this.handleListSessions(req, res);
                    return;
                case '/v1/ai/sessions':
                    await this.handleListAiSessions(req, res);
                    return;
                case '/v1/ai/activity':
                    await this.handleListAiActivity(req, res);
                    return;
                case '/v1/ai/tokens':
                    await this.handleListAiTokens(req, res);
                    return;
                default:
                    this.sendJson(res, 404, {
                        success: false,
                        error: `Endpoint not found: ${pathname}`,
                        timestamp: new Date().toISOString()
                    });
            }
        }
        catch (error) {
            if (error instanceof RequestBodyTooLargeError) {
                this.deps.metrics.increment('codepulse_http_body_too_large_total');
                this.sendJson(res, 413, {
                    success: false,
                    error: 'Payload too large',
                    timestamp: new Date().toISOString()
                });
                return;
            }
            this.deps.metrics.increment('codepulse_http_errors_total');
            this.sendJson(res, 500, {
                success: false,
                error: error instanceof Error ? error.message : 'Internal server error',
                timestamp: new Date().toISOString()
            });
        }
    }
    async handleListSessions(req, res) {
        const url = new URL(req.url ?? '/', `http://${this.deps.config.host}`);
        const sessions = await this.deps.database.listSessions({
            days: parseOptionalInt(url.searchParams.get('days')),
            limit: parseOptionalInt(url.searchParams.get('limit'))
        });
        this.sendJson(res, 200, {
            success: true,
            data: {
                sessions: sessions.map(row => ({
                    id: row.id,
                    startTime: row.start_time,
                    endTime: row.end_time ?? undefined,
                    duration: row.duration,
                    idleDuration: row.idle_duration,
                    project: row.project,
                    language: row.language,
                    file: row.file,
                    branch: row.branch ?? undefined,
                    isActive: row.is_active === 1,
                    heartbeats: row.heartbeats,
                    keystrokes: row.keystrokes,
                    linesAdded: row.lines_added,
                    linesRemoved: row.lines_removed,
                    productivityScore: row.productivity_score ?? undefined,
                    tags: parseTagsJson(row.tags)
                })),
                total: sessions.length
            },
            timestamp: new Date().toISOString()
        });
    }
    async handleListAiSessions(req, res) {
        const url = new URL(req.url ?? '/', `http://${this.deps.config.host}`);
        // listAiSessions clamps internally (default 50, max 1000).
        const sessions = await this.deps.database.listAiSessions(parseOptionalInt(url.searchParams.get('limit')));
        const tokenTotals = await this.sumTokenUsageBySession(sessions.map(session => session.id));
        const nowMs = Date.now();
        // ALL time fields are milliseconds: durationMs is wall-clock run time
        // (open sessions count up to now), activeDurationMs is gap-windowed
        // active work time.
        const enriched = sessions.map(session => {
            const totals = tokenTotals.get(session.id);
            const startedAtMs = Date.parse(session.started_at);
            const endedAtMs = session.ended_at ? Date.parse(session.ended_at) : nowMs;
            const durationMs = Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
                ? Math.max(0, endedAtMs - startedAtMs)
                : undefined;
            return {
                id: session.id,
                tool: session.tool,
                model: session.model ?? undefined,
                startedAt: session.started_at,
                endedAt: session.ended_at ?? undefined,
                durationMs,
                activeDurationMs: Math.round((session.active_duration ?? 0) * 1000),
                lastActivityAt: session.last_activity_at ?? undefined,
                isActive: session.ended_at === null,
                inputTokens: totals?.inputTokens ?? 0,
                outputTokens: totals?.outputTokens ?? 0
            };
        });
        this.sendJson(res, 200, {
            success: true,
            data: {
                sessions: enriched,
                total: enriched.length
            },
            timestamp: new Date().toISOString()
        });
    }
    /**
     * Token sums for the listed sessions in one grouped read per id chunk —
     * replaces the former per-session N+1 loop. Reaches through DatabaseV5's
     * private read helper because core exposes no grouped-by-session token
     * aggregate yet; the query is read-only (reads are unqueued by design).
     */
    async sumTokenUsageBySession(sessionIds) {
        const totals = new Map();
        if (sessionIds.length === 0) {
            return totals;
        }
        const reader = this.deps.database;
        // Chunk the IN list well under SQLite's bound-parameter ceiling.
        const CHUNK_SIZE = 400;
        for (let offset = 0; offset < sessionIds.length; offset += CHUNK_SIZE) {
            const chunk = sessionIds.slice(offset, offset + CHUNK_SIZE);
            const rows = await reader.all(`
                    SELECT
                        ai_session_id,
                        SUM(input_tokens) AS input_tokens,
                        SUM(output_tokens) AS output_tokens
                    FROM ai_token_usage
                    WHERE ai_session_id IN (${chunk.map(() => '?').join(', ')})
                    GROUP BY ai_session_id
                `, chunk);
            for (const row of rows) {
                totals.set(row.ai_session_id, {
                    inputTokens: row.input_tokens ?? 0,
                    outputTokens: row.output_tokens ?? 0
                });
            }
        }
        return totals;
    }
    async handleListAiActivity(req, res) {
        const url = new URL(req.url ?? '/', `http://${this.deps.config.host}`);
        // Day-window clamping (default 7, max 90, floor 1) lives in the DB
        // method; rows are already camelCase with ms time fields.
        const activity = await this.deps.database.listAiActivityByDay({
            days: parseOptionalInt(url.searchParams.get('days'))
        });
        this.sendJson(res, 200, {
            success: true,
            data: {
                activity,
                total: activity.length
            },
            timestamp: new Date().toISOString()
        });
    }
    async handleListAiTokens(req, res) {
        const url = new URL(req.url ?? '/', `http://${this.deps.config.host}`);
        // Clamp to [1, AI_TOKENS_MAX_DAYS] so one request cannot fan out
        // unbounded sequential per-day queries — mirrors /v1/ai/activity and
        // /v1/sessions, which cap their day window at 90.
        const days = Math.min(constants_1.AI_TOKENS_MAX_DAYS, Math.max(1, parseOptionalInt(url.searchParams.get('days')) ?? 1));
        const anchorDay = url.searchParams.get('day') ?? new Date().toISOString().slice(0, 10);
        const dayList = listDaysEndingAt(anchorDay, days);
        const aggregates = (await Promise.all(dayList.map(day => this.deps.database.aggregateTokenUsageByDay(day)))).flat();
        this.sendJson(res, 200, {
            success: true,
            data: aggregates.map(row => ({
                day: row.day,
                tool: row.tool,
                model: row.model ?? undefined,
                inputTokens: row.inputTokens,
                outputTokens: row.outputTokens,
                totalTokens: row.totalTokens
            })),
            timestamp: new Date().toISOString()
        });
    }
    async handleIngestEvents(req, res) {
        const body = await readJsonBody(req);
        const events = Array.isArray(body.events) ? body.events : [];
        let accepted = 0;
        const spoolLines = [];
        for (const raw of events) {
            const result = (0, protocol_1.validateEnvelope)(raw);
            if (!result.ok) {
                continue;
            }
            const envelope = result.value;
            spoolLines.push(JSON.stringify(envelope));
            const ingested = await this.deps.database.ingestEnvelopeFromSpool(envelope);
            if (ingested) {
                accepted += 1;
            }
            // Do NOT broadcast here. Each envelope is appended to the spool below;
            // the daemon's own spool tailer re-ingests it and is the single
            // broadcast point, so broadcasting here would double-deliver.
        }
        if (spoolLines.length > 0) {
            ensureSpoolDir(this.deps.config.spoolPath);
            fs.appendFileSync(this.deps.config.spoolPath, `${spoolLines.join('\n')}\n`, 'utf8');
        }
        this.deps.metrics.increment('codepulse_http_ingest_events_total', events.length);
        this.deps.metrics.increment('codepulse_http_ingest_accepted_total', accepted);
        this.sendJson(res, 200, {
            success: true,
            data: {
                received: events.length,
                accepted
            },
            timestamp: new Date().toISOString()
        });
    }
    async handleListSnapshots(req, res) {
        const url = new URL(req.url ?? '/', `http://${this.deps.config.host}`);
        const snapshots = await this.deps.snapshotManager.listSnapshots({
            aiSessionId: url.searchParams.get('ai_session_id') ?? undefined,
            sessionId: url.searchParams.get('session_id') ?? undefined,
            project: url.searchParams.get('project') ?? undefined,
            snapshotType: url.searchParams.get('snapshot_type') ?? undefined,
            limit: parseOptionalInt(url.searchParams.get('limit')),
            offset: parseOptionalInt(url.searchParams.get('offset'))
        });
        this.sendJson(res, 200, {
            success: true,
            data: { snapshots },
            timestamp: new Date().toISOString()
        });
    }
    async handleCreateSnapshot(req, res) {
        const body = await readJsonBody(req);
        if (!body.project || !body.projectRoot || !body.filePath) {
            this.sendJson(res, 400, {
                success: false,
                error: 'project, projectRoot, and filePath are required',
                timestamp: new Date().toISOString()
            });
            return;
        }
        let snapshot;
        try {
            snapshot = await this.deps.snapshotManager.createPreAiSnapshot({
                project: body.project,
                projectRoot: body.projectRoot,
                filePath: body.filePath,
                aiSessionId: body.aiSessionId,
                sessionId: body.sessionId,
                contentBefore: body.contentBefore
            });
        }
        catch (error) {
            if (error instanceof core_1.UntrustedProjectRootError) {
                this.sendJson(res, 400, {
                    success: false,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
                return;
            }
            throw error;
        }
        this.deps.metrics.increment('codepulse_snapshots_created_total');
        this.sendJson(res, 201, {
            success: true,
            data: { snapshot },
            timestamp: new Date().toISOString()
        });
    }
    async handleRestoreSnapshot(req, res, snapshotId) {
        if (req.method !== 'POST') {
            this.sendJson(res, 405, {
                success: false,
                error: `Method not allowed: ${req.method}`,
                timestamp: new Date().toISOString()
            });
            return;
        }
        const url = new URL(req.url ?? '/', `http://${this.deps.config.host}`);
        const dryRun = url.searchParams.get('dry_run') !== 'false';
        const recoveryToken = url.searchParams.get('recovery_token') ?? undefined;
        const result = await this.deps.snapshotManager.restoreSnapshot(snapshotId, {
            dryRun,
            recoveryToken
        });
        this.deps.metrics.increment(dryRun ? 'codepulse_snapshots_restore_dry_run_total' : 'codepulse_snapshots_restore_confirmed_total');
        this.sendJson(res, 200, {
            success: true,
            data: result,
            timestamp: new Date().toISOString()
        });
    }
    buildCapabilities() {
        return {
            version: constants_1.DAEMON_VERSION,
            protocol: constants_1.PROTOCOL,
            features: ['http', 'websocket', 'spool', 'registry', 'scanner', 'metrics', 'snapshots', 'ai'],
            http: {
                port: this.deps.config.httpPort,
                endpoints: [...constants_1.HTTP_ENDPOINTS]
            },
            websocket: {
                port: this.deps.config.wsPort,
                events: [...constants_1.SUPPORTED_WS_EVENTS]
            },
            spool: {
                path: this.deps.config.spoolPath,
                supported: true
            },
            registry: {
                supported: true
            }
        };
    }
    isHostAllowed(req) {
        return (0, cors_1.isLoopbackHost)(req);
    }
    isLocalhost(req) {
        const remote = req.socket.remoteAddress ?? '';
        return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    }
    /**
     * Only the Tauri desktop shell's webview origins are trusted to receive the
     * bearer token from /v1/bootstrap. Fails closed: a missing or unknown Origin
     * (curl, DNS-rebound same-origin fetch, arbitrary localhost browser tab) is
     * NOT trusted and gets ports/host only — no token.
     */
    isTrustedBootstrapClient(req) {
        const origin = req.headers.origin;
        if (!origin || typeof origin !== 'string') {
            return false;
        }
        return (origin === 'tauri://localhost' ||
            origin === 'https://tauri.localhost' ||
            origin === 'http://tauri.localhost');
    }
    isAuthorized(req) {
        const pathname = new URL(req.url ?? '/', `http://${this.deps.config.host}`).pathname;
        if (pathname === '/v1/health' || pathname === '/v1/metrics' || pathname === '/v1/bootstrap') {
            return true;
        }
        const authHeader = req.headers.authorization;
        if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
            return (0, cors_1.timingSafeEqualString)(authHeader.slice(7).trim(), this.deps.authToken);
        }
        const url = new URL(req.url ?? '/', `http://${this.deps.config.host}`);
        const queryToken = url.searchParams.get('token');
        return queryToken !== null && (0, cors_1.timingSafeEqualString)(queryToken, this.deps.authToken);
    }
    sendJson(res, statusCode, body) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    }
}
exports.DaemonHttpServer = DaemonHttpServer;
function sanitizeMetricName(pathname) {
    return pathname.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}
function parseTagsJson(raw) {
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(tag => typeof tag === 'string') : [];
    }
    catch {
        return [];
    }
}
function parseOptionalInt(value) {
    if (!value) {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function listDaysEndingAt(anchorDay, days) {
    const anchor = new Date(`${anchorDay}T00:00:00.000Z`);
    if (Number.isNaN(anchor.getTime())) {
        throw new Error(`Invalid day format: ${anchorDay}`);
    }
    const result = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const date = new Date(anchor);
        date.setUTCDate(date.getUTCDate() - offset);
        result.push(date.toISOString().slice(0, 10));
    }
    return result;
}
function ensureSpoolDir(spoolPath) {
    fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
}
/**
 * Thrown by the shared body reader when an inbound request body exceeds
 * MAX_REQUEST_BODY_BYTES. Handlers translate this into an HTTP 413 instead of a
 * generic 500 so an oversized body never buffers past the cap.
 */
class RequestBodyTooLargeError extends Error {
    limitBytes;
    constructor(limitBytes) {
        super(`Request body exceeds ${limitBytes} bytes`);
        this.limitBytes = limitBytes;
        this.name = 'RequestBodyTooLargeError';
    }
}
async function readJsonBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > constants_1.MAX_REQUEST_BODY_BYTES) {
            // Stop buffering immediately and tear down the stream so the rest of
            // the oversized payload is never read into memory.
            req.destroy();
            throw new RequestBodyTooLargeError(constants_1.MAX_REQUEST_BODY_BYTES);
        }
        chunks.push(buffer);
    }
    if (chunks.length === 0) {
        return {};
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
        return {};
    }
    return JSON.parse(raw);
}
//# sourceMappingURL=server.js.map