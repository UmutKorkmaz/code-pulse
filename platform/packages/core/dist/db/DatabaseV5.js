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
exports.DatabaseV5 = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const async_hooks_1 = require("async_hooks");
const sqlite3 = __importStar(require("sqlite3"));
const schema_v5_1 = require("./schema-v5");
const SESSION_LIST_DEFAULT_DAYS = 7;
const SESSION_LIST_MAX_DAYS = 90;
const SESSION_LIST_DEFAULT_LIMIT = 200;
const SESSION_LIST_MAX_LIMIT = 1000;
const AI_SESSION_LIST_DEFAULT_LIMIT = 50;
const AI_SESSION_LIST_MAX_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Activity gap window — events at most this far apart extend active time by the gap. */
const ACTIVITY_GAP_SECONDS = 300;
/** Grant for isolated events: first event or gap > window. Out-of-order events grant nothing. */
const ACTIVITY_ISOLATED_GRANT_SECONDS = 30;
/**
 * Max age a detection-only session's started_at may predate server receipt.
 * validateEnvelope only bounds ts to [0, 8.64e15], so any local process holding
 * the bearer token could POST a single ai.tool.detected with a far-past ts;
 * since detection sessions have no end event, run_ms = now - started_at would
 * inflate without bound. Floor started_at to server-now minus this window so a
 * backdated ts cannot manufacture arbitrary run time.
 */
const DETECTION_STARTED_AT_FLOOR_MS = 4 * 60 * 60 * 1000;
class DatabaseV5 {
    db = null;
    dbPath;
    writeQueue = Promise.resolve();
    /**
     * Marks async call chains already executing inside a queued write —
     * AsyncLocalStorage (not a boolean flag) because the marker must follow
     * the async chain across awaits, where interleaved outside callers would
     * otherwise observe a stale flag and bypass the queue.
     */
    writeScope = new async_hooks_1.AsyncLocalStorage();
    constructor(dataDir, dbFileName = 'codepulse.db') {
        this.dbPath = path.join(dataDir, dbFileName);
    }
    get path() {
        return this.dbPath;
    }
    async open() {
        await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true });
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, async (error) => {
                if (error) {
                    reject(new Error(`Failed to open database: ${error.message}`));
                    return;
                }
                try {
                    await this.run('PRAGMA foreign_keys = ON');
                    await this.run('PRAGMA busy_timeout = 5000');
                    await this.migrate();
                    resolve();
                }
                catch (migrateError) {
                    reject(migrateError);
                }
            });
        });
    }
    async close() {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                resolve();
                return;
            }
            this.db.close(error => {
                if (error) {
                    reject(new Error(`Failed to close database: ${error.message}`));
                    return;
                }
                this.db = null;
                resolve();
            });
        });
    }
    async getSchemaVersion() {
        const row = await this.get(`SELECT value FROM meta WHERE key = 'schema_version'`);
        return Number(row?.value ?? '0');
    }
    async migrate() {
        await this.run(`
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            `);
        await this.run(`
                INSERT OR IGNORE INTO meta (key, value)
                VALUES ('schema_version', '0')
            `);
        let currentVersion = await this.getSchemaVersion();
        if (currentVersion < 1) {
            await this.migrateToV1();
            currentVersion = 1;
            await this.setSchemaVersion(currentVersion);
        }
        if (currentVersion < 2) {
            await this.migrateToV2();
            currentVersion = 2;
            await this.setSchemaVersion(currentVersion);
        }
        if (currentVersion < 3) {
            await this.migrateToV3();
            currentVersion = 3;
            await this.setSchemaVersion(currentVersion);
        }
        if (currentVersion < 4) {
            await this.migrateToV4();
            currentVersion = 4;
            await this.setSchemaVersion(currentVersion);
        }
        if (currentVersion < 5) {
            await this.migrateToV5();
            currentVersion = 5;
            await this.setSchemaVersion(currentVersion);
        }
        if (currentVersion < 6) {
            await this.migrateToV6();
            currentVersion = 6;
            await this.setSchemaVersion(currentVersion);
        }
        if (currentVersion < 7) {
            await this.migrateToV7();
            currentVersion = 7;
            await this.setSchemaVersion(currentVersion);
        }
        if (currentVersion < schema_v5_1.SCHEMA_VERSION) {
            await this.migrateToV8();
            currentVersion = schema_v5_1.SCHEMA_VERSION;
            await this.setSchemaVersion(currentVersion);
        }
    }
    async insertAiSession(session) {
        await this.run(`
                INSERT INTO ai_sessions (
                    id, session_id, scanner_id, tool, model, started_at, ended_at, confidence, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
            session.id,
            session.session_id,
            session.scanner_id,
            session.tool,
            session.model,
            session.started_at,
            session.ended_at,
            session.confidence,
            session.source
        ]);
    }
    /** Idempotent insert — ignores duplicate primary keys (scanner races / log replay). */
    async insertAiSessionIfNotExists(session) {
        const result = await this.run(`
                INSERT OR IGNORE INTO ai_sessions (
                    id, session_id, scanner_id, tool, model, started_at, ended_at, confidence, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
            session.id,
            session.session_id,
            session.scanner_id,
            session.tool,
            session.model,
            session.started_at,
            session.ended_at,
            session.confidence,
            session.source
        ]);
        return (result.changes ?? 0) > 0;
    }
    async getAiSession(id) {
        return this.get('SELECT * FROM ai_sessions WHERE id = ?', [id]);
    }
    /**
     * Lists AI sessions newest first. `limit` is clamped (default 50, max
     * 1000); rows include last_activity_at + active_duration so callers can
     * derive activeDurationMs / lastActivityAt / isActive.
     */
    async listAiSessions(limit = AI_SESSION_LIST_DEFAULT_LIMIT, offset = 0) {
        const clampedLimit = clampListParam(limit, AI_SESSION_LIST_MAX_LIMIT, AI_SESSION_LIST_DEFAULT_LIMIT);
        const clampedOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
        return this.all('SELECT * FROM ai_sessions ORDER BY started_at DESC LIMIT ? OFFSET ?', [clampedLimit, clampedOffset]);
    }
    /**
     * Aggregates AI run/active time and token usage per local day × tool over
     * the clamped day window (default 7, max 90). Run time is the wall-clock
     * span [started_at, ended_at ?? now] split across the local days it
     * covers, so a session straddling midnight credits each day with only the
     * portion that fell inside it (bounding any day at 24h by construction);
     * spans are clipped to the whole-local-day window so backdated/open
     * sessions cannot leak run time outside the requested days. The lower
     * bound is computed by applying the day clamp (default 7, max 90), then
     * snapping that instant down to its local midnight; run spans, active
     * buckets, and token usage all use that same whole-day lower bound.
     * Sessions count toward every day they overlap. Active time is summed
     * from ai_activity_daily — the accumulator splits every credited interval
     * across the local day(s) it covers, so a session straddling midnight
     * credits each day exactly. Token usage is attributed to the local day
     * each usage row was recorded, matching aggregateTokenUsageByDay.
     */
    async listAiActivityByDay(opts = {}) {
        const days = clampListParam(opts.days, SESSION_LIST_MAX_DAYS, SESSION_LIST_DEFAULT_DAYS);
        const nowMs = Date.now();
        const sinceMs = localMidnightMs(nowMs - days * DAY_MS);
        const nowIso = new Date(nowMs).toISOString();
        const sinceIso = new Date(sinceMs).toISOString();
        const sessionRows = await this.all(`
                SELECT tool, started_at, ended_at
                FROM ai_sessions
                WHERE COALESCE(ended_at, ?) >= ?
            `, [nowIso, sinceIso]);
        const buckets = new Map();
        const bucketFor = (day, tool) => {
            const key = `${day} ${tool}`;
            let bucket = buckets.get(key);
            if (!bucket) {
                bucket = {
                    day,
                    tool,
                    runMs: 0,
                    activeMs: 0,
                    sessions: 0,
                    inputTokens: 0,
                    outputTokens: 0
                };
                buckets.set(key, bucket);
            }
            return bucket;
        };
        for (const session of sessionRows) {
            const startedMs = Date.parse(session.started_at);
            if (!Number.isFinite(startedMs)) {
                continue;
            }
            const endedMs = session.ended_at ? Date.parse(session.ended_at) : nowMs;
            const spanStartMs = Math.max(startedMs, sinceMs);
            const spanEndMs = Math.max(spanStartMs, Math.min(Number.isFinite(endedMs) ? endedMs : nowMs, nowMs));
            for (const slice of splitSpanByLocalDay(spanStartMs, spanEndMs)) {
                const bucket = bucketFor(slice.day, session.tool);
                bucket.runMs += slice.runMs;
                bucket.sessions += 1;
            }
        }
        const activeRows = await this.all(`
                SELECT
                    d.day AS day,
                    s.tool AS tool,
                    COALESCE(SUM(d.active_seconds), 0) AS active_seconds
                FROM ai_activity_daily d
                INNER JOIN ai_sessions s ON s.id = d.ai_session_id
                WHERE d.day >= ? AND d.day <= ?
                GROUP BY d.day, s.tool
            `, [formatLocalDay(new Date(sinceMs)), formatLocalDay(new Date(nowMs))]);
        for (const row of activeRows) {
            bucketFor(row.day, row.tool).activeMs += Math.round(row.active_seconds * 1000);
        }
        const tokenRows = await this.all(`
                SELECT
                    date(u.recorded_at, 'localtime') AS day,
                    s.tool AS tool,
                    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(u.output_tokens), 0) AS output_tokens
                FROM ai_token_usage u
                INNER JOIN ai_sessions s ON s.id = u.ai_session_id
                WHERE u.recorded_at >= ?
                GROUP BY day, tool
            `, [sinceIso]);
        for (const row of tokenRows) {
            const bucket = bucketFor(row.day, row.tool);
            bucket.inputTokens += row.input_tokens;
            bucket.outputTokens += row.output_tokens;
        }
        return [...buckets.values()].sort((a, b) => compareAscii(a.day, b.day) || compareAscii(a.tool, b.tool));
    }
    /**
     * Closes open AI sessions whose last observed activity (falling back to
     * started_at) is older than the cutoff, setting ended_at to that
     * last-activity time. Returns the number of sessions closed.
     */
    async endStaleAiSessions(olderThanMinutes) {
        if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0) {
            throw new Error(`olderThanMinutes must be a non-negative number: ${olderThanMinutes}`);
        }
        const cutoffIso = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
        const result = await this.run(`
                UPDATE ai_sessions
                SET ended_at = COALESCE(last_activity_at, started_at)
                WHERE ended_at IS NULL
                  AND COALESCE(last_activity_at, started_at) < ?
            `, [cutoffIso]);
        return result.changes ?? 0;
    }
    /**
     * Lists coding sessions (persisted by ingestEnvelopeFromSpool) that
     * started within the last `days` days, newest first. Both params are
     * clamped to sane bounds — negatives and zero floor to 1, oversized
     * values cap at 90 days / 1000 rows.
     */
    async listSessions(options = {}) {
        const days = clampListParam(options.days, SESSION_LIST_MAX_DAYS, SESSION_LIST_DEFAULT_DAYS);
        const limit = clampListParam(options.limit, SESSION_LIST_MAX_LIMIT, SESSION_LIST_DEFAULT_LIMIT);
        const since = new Date(Date.now() - days * DAY_MS).toISOString();
        return this.all(`
                SELECT * FROM sessions
                WHERE start_time >= ?
                ORDER BY start_time DESC
                LIMIT ?
            `, [since, limit]);
    }
    async insertAiTokenUsage(usage) {
        const result = await this.run(`
                INSERT INTO ai_token_usage (
                    ai_session_id, model, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, estimated, recorded_at, envelope_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
            usage.ai_session_id,
            usage.model,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_write_tokens,
            usage.estimated,
            usage.recorded_at,
            usage.envelope_id
        ]);
        return result.lastID;
    }
    /**
     * Idempotent variant for envelope ingest — INSERT OR IGNORE against the
     * unique envelope_id index. Returns false when the envelope was already
     * recorded (replayed log line / spool re-read).
     */
    async insertAiTokenUsageIfNew(usage) {
        const result = await this.run(`
                INSERT OR IGNORE INTO ai_token_usage (
                    ai_session_id, model, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, estimated, recorded_at, envelope_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
            usage.ai_session_id,
            usage.model,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_write_tokens,
            usage.estimated,
            usage.recorded_at,
            usage.envelope_id
        ]);
        return (result.changes ?? 0) > 0;
    }
    async listAiTokenUsage(aiSessionId) {
        return this.all('SELECT * FROM ai_token_usage WHERE ai_session_id = ? ORDER BY recorded_at ASC', [aiSessionId]);
    }
    async insertFileSnapshot(snapshot) {
        await this.run(`
                INSERT INTO file_snapshots (
                    id, ai_session_id, session_id, project, file_path, snapshot_type,
                    diff_path, file_hash_before, file_hash_after, size_bytes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
            snapshot.id,
            snapshot.ai_session_id,
            snapshot.session_id,
            snapshot.project,
            snapshot.file_path,
            snapshot.snapshot_type,
            snapshot.diff_path,
            snapshot.file_hash_before,
            snapshot.file_hash_after,
            snapshot.size_bytes
        ]);
    }
    async getFileSnapshot(id) {
        return this.get('SELECT * FROM file_snapshots WHERE id = ?', [id]);
    }
    async listFileSnapshots(filter = {}) {
        const clauses = [];
        const params = [];
        if (filter.aiSessionId) {
            clauses.push('ai_session_id = ?');
            params.push(filter.aiSessionId);
        }
        if (filter.sessionId) {
            clauses.push('session_id = ?');
            params.push(filter.sessionId);
        }
        if (filter.project) {
            clauses.push('project = ?');
            params.push(filter.project);
        }
        if (filter.snapshotType) {
            clauses.push('snapshot_type = ?');
            params.push(filter.snapshotType);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const limit = filter.limit ?? 100;
        const offset = filter.offset ?? 0;
        return this.all(`
                SELECT * FROM file_snapshots
                ${where}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
            `, [...params, limit, offset]);
    }
    async upsertRegistryScanner(scanner) {
        await this.run(`
                INSERT INTO registry_scanners (
                    id, version, trust, enabled, installed_at, last_scan_at, manifest_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    version = excluded.version,
                    trust = excluded.trust,
                    enabled = excluded.enabled,
                    installed_at = COALESCE(registry_scanners.installed_at, excluded.installed_at),
                    last_scan_at = excluded.last_scan_at,
                    manifest_hash = excluded.manifest_hash
            `, [
            scanner.id,
            scanner.version,
            scanner.trust,
            scanner.enabled,
            scanner.installed_at,
            scanner.last_scan_at,
            scanner.manifest_hash
        ]);
    }
    async touchRegistryScannerLastScan(scannerId, lastScanAt) {
        await this.run(`
                UPDATE registry_scanners
                SET last_scan_at = ?
                WHERE id = ?
            `, [lastScanAt, scannerId]);
    }
    async listRegistryScanners() {
        return this.all('SELECT * FROM registry_scanners ORDER BY id ASC');
    }
    async endAiSession(id, endedAt) {
        const result = await this.run(`
                UPDATE ai_sessions
                SET ended_at = ?
                WHERE id = ? AND ended_at IS NULL
            `, [endedAt, id]);
        return (result.changes ?? 0) > 0;
    }
    async upsertParserCursor(cursor) {
        await this.run(`
                INSERT INTO parser_cursors (
                    scanner_id, log_glob, byte_offset, inode, last_event_id
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(scanner_id, log_glob) DO UPDATE SET
                    byte_offset = excluded.byte_offset,
                    inode = excluded.inode,
                    last_event_id = excluded.last_event_id
            `, [
            cursor.scanner_id,
            cursor.log_glob,
            cursor.byte_offset,
            cursor.inode,
            cursor.last_event_id
        ]);
    }
    async getParserCursor(scannerId, logGlob) {
        return this.get('SELECT * FROM parser_cursors WHERE scanner_id = ? AND log_glob = ?', [scannerId, logGlob]);
    }
    async insertPrivacyAudit(entry) {
        const result = await this.run(`
                INSERT INTO privacy_audit (actor, operation, target_hash, occurred_at)
                VALUES (?, ?, ?, ?)
            `, [entry.actor, entry.operation, entry.target_hash, entry.occurred_at]);
        return result.lastID;
    }
    async listPrivacyAudit(limit = 100, offset = 0) {
        return this.all('SELECT * FROM privacy_audit ORDER BY occurred_at DESC LIMIT ? OFFSET ?', [limit, offset]);
    }
    async aggregateTokenUsageByDay(day) {
        const rows = await this.all(`
                SELECT
                    s.tool AS tool,
                    u.model AS model,
                    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
                    COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
                    COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
                    COALESCE(SUM(u.estimated), 0) AS estimated_rows
                FROM ai_token_usage u
                INNER JOIN ai_sessions s ON s.id = u.ai_session_id
                WHERE u.recorded_at >= ? AND u.recorded_at < ?
                GROUP BY s.tool, u.model
                ORDER BY s.tool ASC, u.model ASC
            `, [`${day}T00:00:00.000Z`, `${nextDay(day)}T00:00:00.000Z`]);
        return rows.map(row => ({
            day,
            tool: row.tool,
            model: row.model,
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            cacheReadTokens: row.cache_read_tokens,
            cacheWriteTokens: row.cache_write_tokens,
            totalTokens: row.input_tokens +
                row.output_tokens +
                row.cache_read_tokens +
                row.cache_write_tokens,
            estimatedRows: row.estimated_rows
        }));
    }
    /**
     * Ingests one envelope inside its own transaction so an envelope's
     * effects (e.g. token row) and its dedup marker can never be split by a
     * crash. Returns false for replays — dedup runs against the unique
     * envelope_id indexes instead of a json_extract full-table scan.
     */
    async ingestEnvelopeFromSpool(envelope) {
        return this.withTransaction(() => this.ingestEnvelopeInTransaction(envelope));
    }
    /**
     * Atomically ingests a parsed-log batch and persists its parser cursor in
     * ONE transaction — a crash mid-batch can never advance the cursor past
     * unrecorded events or record events the cursor will replay. Returns the
     * envelopes that were newly ingested (replays are filtered out).
     */
    async ingestLogBatchWithCursor(envelopes, cursor) {
        return this.withTransaction(async () => {
            const ingested = [];
            for (const envelope of envelopes) {
                if (await this.ingestEnvelopeInTransaction(envelope)) {
                    ingested.push(envelope);
                }
            }
            await this.upsertParserCursor(cursor);
            return ingested;
        });
    }
    async ingestEnvelopeInTransaction(envelope) {
        switch (envelope.payload.type) {
            case 'ai.tool.detected':
                return this.ingestToolDetectedEnvelope(envelope);
            case 'ai.tokens':
                return this.ingestTokensEnvelope(envelope);
            case 'ai.session.started':
                return this.ingestSessionStartedEnvelope(envelope);
            case 'ai.session.ended':
                return this.ingestSessionEndedEnvelope(envelope);
            case 'session.updated':
                return this.ingestCodingSessionEnvelope(envelope, false);
            case 'session.ended':
                return this.ingestCodingSessionEnvelope(envelope, true);
            default:
                return false;
        }
    }
    async ingestSessionStartedEnvelope(envelope) {
        const payload = envelope.payload;
        if (payload.type !== 'ai.session.started') {
            return false;
        }
        const session = payload.aiSession;
        // Single session per (scanner, tool): when one is already open, every
        // source attaches to it instead of opening a duplicate (also makes
        // replayed started envelopes no-ops).
        const active = await this.findActiveAiSession(session.scannerId, session.tool);
        if (active) {
            return false;
        }
        // Daemon-restart guard: the process watcher backdates startedAt via
        // etime (full process uptime), but part of that span was already
        // credited to the prior session for this (scanner, tool) — which the
        // startup stale sweep just closed at its last activity. Clamp the new
        // start to the latest ended_at so adjacent sessions never overlap and
        // the outage span is not double-counted.
        const startedAt = await this.clampStartToLastEnded(session.scannerId, session.tool, session.startedAt);
        const inserted = await this.insertAiSessionIfNotExists({
            id: session.id,
            session_id: session.sessionId ?? null,
            scanner_id: session.scannerId,
            tool: session.tool,
            model: session.model ?? null,
            started_at: startedAt,
            ended_at: null,
            confidence: session.confidence ?? 0.9,
            source: session.source ?? envelope.src
        });
        if (inserted) {
            const startedAtMs = Date.parse(startedAt);
            await this.accumulateAiActivity(session.id, Number.isFinite(startedAtMs) ? startedAtMs : envelope.ts);
        }
        return inserted;
    }
    async ingestSessionEndedEnvelope(envelope) {
        const payload = envelope.payload;
        if (payload.type !== 'ai.session.ended') {
            return false;
        }
        const session = payload.aiSession;
        const endedAt = session.endedAt ?? session.startedAt;
        return this.endAiSession(session.id, endedAt);
    }
    /**
     * Persists forwarded coding sessions — keyed on the session's own id (NOT
     * the envelope id), so repeated session.updated envelopes converge on one
     * row instead of being dropped while the spool grows.
     */
    async ingestCodingSessionEnvelope(envelope, markEnded) {
        const payload = envelope.payload;
        if (payload.type !== 'session.updated' && payload.type !== 'session.ended') {
            return false;
        }
        const session = payload.session;
        const endTime = markEnded
            ? session.endTime ?? new Date(envelope.ts).toISOString()
            : session.endTime ?? null;
        const isActive = markEnded ? 0 : session.isActive ? 1 : 0;
        await this.run(`
                INSERT INTO sessions (
                    id, start_time, end_time, duration, idle_duration, project, language,
                    file, branch, is_active, heartbeats, keystrokes, lines_added,
                    lines_removed, productivity_score, tags
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    start_time = excluded.start_time,
                    end_time = excluded.end_time,
                    duration = excluded.duration,
                    idle_duration = excluded.idle_duration,
                    project = excluded.project,
                    language = excluded.language,
                    file = excluded.file,
                    branch = excluded.branch,
                    is_active = excluded.is_active,
                    heartbeats = excluded.heartbeats,
                    keystrokes = excluded.keystrokes,
                    lines_added = excluded.lines_added,
                    lines_removed = excluded.lines_removed,
                    productivity_score = excluded.productivity_score,
                    tags = excluded.tags,
                    updated_at = CURRENT_TIMESTAMP
            `, [
            session.id,
            session.startTime,
            endTime,
            session.duration,
            session.idleDuration,
            session.project,
            session.language,
            session.file,
            session.branch ?? null,
            isActive,
            session.heartbeats,
            session.keystrokes,
            session.linesAdded,
            session.linesRemoved,
            session.productivityScore ?? null,
            JSON.stringify(session.tags ?? [])
        ]);
        return true;
    }
    async ingestToolDetectedEnvelope(envelope) {
        const payload = envelope.payload;
        if (payload.type !== 'ai.tool.detected') {
            return false;
        }
        const scannerId = payload.scannerId ?? envelope.src;
        const occurredAt = new Date(envelope.ts).toISOString();
        // Detection sessions never receive an explicit end event, so run_ms is
        // computed from started_at up to now. Floor started_at to server-now
        // minus the backdating window so a forged/backdated ts cannot inflate
        // reported run time. The actual envelope ts still drives the tool event
        // and accumulateAiActivity (which is gap-clamped) below.
        const startedAt = new Date(Math.max(envelope.ts, Date.now() - DETECTION_STARTED_AT_FLOOR_MS)).toISOString();
        let aiSession = await this.findActiveAiSession(scannerId, payload.tool);
        if (!aiSession) {
            await this.insertAiSessionIfNotExists({
                id: envelope.id,
                session_id: null,
                scanner_id: scannerId,
                tool: payload.tool,
                model: null,
                started_at: startedAt,
                ended_at: null,
                confidence: payload.confidence,
                source: resolveDetectionSource(envelope.src, payload.evidence)
            });
            aiSession =
                (await this.getAiSession(envelope.id)) ??
                    (await this.findActiveAiSession(scannerId, payload.tool));
        }
        if (!aiSession) {
            throw new Error(`Failed to resolve AI session for envelope ${envelope.id}`);
        }
        const recorded = await this.insertAiToolEvent({
            ai_session_id: aiSession.id,
            event_type: 'detected',
            tool: payload.tool,
            metadata: JSON.stringify({
                envelopeId: envelope.id,
                confidence: payload.confidence,
                evidenceCount: payload.evidence.length,
                scannerId
            }),
            occurred_at: occurredAt,
            envelope_id: envelope.id
        });
        if (recorded) {
            await this.accumulateAiActivity(aiSession.id, envelope.ts);
        }
        return recorded;
    }
    async ingestTokensEnvelope(envelope) {
        const payload = envelope.payload;
        if (payload.type !== 'ai.tokens') {
            return false;
        }
        const usage = payload.usage;
        const scannerId = usage.scannerId ?? envelope.src;
        const tool = usage.tool ?? 'unknown';
        const occurredAt = new Date(envelope.ts).toISOString();
        const aiSessionId = await this.resolveAiSessionIdForUsage(envelope.id, usage.aiSessionId, scannerId, tool, occurredAt, usage.model ?? null, usage.isEstimated ? 0.8 : 1);
        const insertedUsage = await this.insertAiTokenUsageIfNew({
            ai_session_id: aiSessionId,
            model: usage.model ?? null,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_read_tokens: usage.cacheReadTokens ?? 0,
            cache_write_tokens: usage.cacheWriteTokens ?? 0,
            estimated: usage.isEstimated ? 1 : 0,
            recorded_at: occurredAt,
            envelope_id: envelope.id
        });
        if (!insertedUsage) {
            // Replayed envelope — the usage and its marker were already
            // recorded atomically the first time around.
            return false;
        }
        await this.insertAiToolEvent({
            ai_session_id: aiSessionId,
            event_type: 'tokens',
            tool,
            metadata: JSON.stringify({
                envelopeId: envelope.id,
                model: usage.model ?? null,
                totalTokens: usage.totalTokens,
                isEstimated: usage.isEstimated
            }),
            occurred_at: occurredAt,
            envelope_id: envelope.id
        });
        await this.accumulateAiActivity(aiSessionId, envelope.ts);
        return true;
    }
    /**
     * Folds one activity observation into the session's gap-windowed active
     * time: a gap of at most ACTIVITY_GAP_SECONDS since the previous activity
     * extends active_duration by the real gap; larger gaps and the first
     * event grant the isolated-event minimum. Out-of-order events (at or
     * before last_activity_at) fall inside an already-credited window, so
     * they grant nothing and never rewind last_activity_at — only
     * forward-in-time events extend the window. The credited interval
     * ([last_activity_at, occurredAt] for an in-window gap, the trailing
     * isolated grant ending at occurredAt otherwise) is clamped to the
     * session's own started_at, then split across the local day(s) it covers
     * and upserted into ai_activity_daily, so day aggregates get exact
     * per-day active time while active_duration stays the session running
     * total. Always runs inside the caller's ingest transaction on the shared
     * serialized write path.
     */
    async accumulateAiActivity(aiSessionId, occurredAtMs) {
        if (!Number.isFinite(occurredAtMs)) {
            return;
        }
        const row = await this.get('SELECT started_at, last_activity_at, active_duration FROM ai_sessions WHERE id = ?', [
            aiSessionId
        ]);
        if (!row) {
            return;
        }
        const startedMs = Date.parse(row.started_at);
        const lastActivityMs = row.last_activity_at ? Date.parse(row.last_activity_at) : NaN;
        if (Number.isFinite(lastActivityMs) && occurredAtMs <= lastActivityMs) {
            return;
        }
        // Credited interval: an in-window gap credits the real gap; the first
        // event and out-of-window gaps credit the isolated grant ending at
        // occurredAt, clamped so it can never reach back into the
        // already-credited window before last_activity_at or before this
        // session's own started_at.
        let creditStartMs = occurredAtMs - ACTIVITY_ISOLATED_GRANT_SECONDS * 1000;
        if (Number.isFinite(startedMs)) {
            creditStartMs = Math.max(creditStartMs, startedMs);
        }
        if (Number.isFinite(lastActivityMs)) {
            const gapSeconds = (occurredAtMs - lastActivityMs) / 1000;
            creditStartMs =
                gapSeconds <= ACTIVITY_GAP_SECONDS
                    ? lastActivityMs
                    : Math.max(creditStartMs, lastActivityMs);
        }
        const grantSeconds = Math.max(0, (occurredAtMs - creditStartMs) / 1000);
        await this.run(`
                UPDATE ai_sessions
                SET active_duration = COALESCE(active_duration, 0) + ?,
                    last_activity_at = ?
                WHERE id = ?
            `, [grantSeconds, new Date(occurredAtMs).toISOString(), aiSessionId]);
        for (const slice of splitSpanByLocalDay(creditStartMs, occurredAtMs)) {
            if (slice.runMs <= 0) {
                continue;
            }
            await this.run(`
                    INSERT INTO ai_activity_daily (ai_session_id, day, active_seconds)
                    VALUES (?, ?, ?)
                    ON CONFLICT(ai_session_id, day) DO UPDATE SET
                        active_seconds = active_seconds + excluded.active_seconds
                `, [aiSessionId, slice.day, slice.runMs / 1000]);
        }
    }
    async resolveAiSessionIdForUsage(envelopeId, aiSessionId, scannerId, tool, startedAt, model, confidence) {
        if (aiSessionId) {
            const existing = await this.getAiSession(aiSessionId);
            if (existing) {
                return existing.id;
            }
            await this.insertAiSessionIfNotExists({
                id: aiSessionId,
                session_id: null,
                scanner_id: scannerId,
                tool,
                model,
                started_at: startedAt,
                ended_at: null,
                confidence,
                source: 'log'
            });
            return aiSessionId;
        }
        const active = await this.findActiveAiSession(scannerId, tool);
        if (active) {
            return active.id;
        }
        await this.insertAiSessionIfNotExists({
            id: envelopeId,
            session_id: null,
            scanner_id: scannerId,
            tool,
            model,
            started_at: startedAt,
            ended_at: null,
            confidence,
            source: 'log'
        });
        return envelopeId;
    }
    /**
     * Clamps a backdated session start to the latest ended_at recorded for
     * the same (scanner, tool), so a freshly opened session can never overlap
     * a previously closed one (overlap would double-count run time). Starts
     * at or after the last end — and starts with no closed predecessor — pass
     * through unchanged.
     */
    async clampStartToLastEnded(scannerId, tool, startedAt) {
        const row = await this.get(`
                SELECT MAX(ended_at) AS last_ended_at
                FROM ai_sessions
                WHERE scanner_id = ? AND tool = ? AND ended_at IS NOT NULL
            `, [scannerId, tool]);
        const lastEndedAt = row?.last_ended_at;
        if (!lastEndedAt) {
            return startedAt;
        }
        const startedMs = Date.parse(startedAt);
        const lastEndedMs = Date.parse(lastEndedAt);
        if (!Number.isFinite(startedMs) || !Number.isFinite(lastEndedMs)) {
            return startedAt;
        }
        return startedMs < lastEndedMs ? lastEndedAt : startedAt;
    }
    async findActiveAiSession(scannerId, tool) {
        return this.get(`
                SELECT * FROM ai_sessions
                WHERE scanner_id = ? AND tool = ? AND ended_at IS NULL
                ORDER BY started_at DESC
                LIMIT 1
            `, [scannerId, tool]);
    }
    /**
     * INSERT OR IGNORE against the unique envelope_id index — returns false
     * when this envelope's event was already recorded (replay).
     */
    async insertAiToolEvent(event) {
        const result = await this.run(`
                INSERT OR IGNORE INTO ai_tool_events (
                    ai_session_id, event_type, tool, metadata, occurred_at, envelope_id
                ) VALUES (?, ?, ?, ?, ?, ?)
            `, [
            event.ai_session_id,
            event.event_type,
            event.tool,
            event.metadata,
            event.occurred_at,
            event.envelope_id
        ]);
        return (result.changes ?? 0) > 0;
    }
    async migrateToV1() {
        await this.run(`
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    start_time TEXT NOT NULL,
                    end_time TEXT,
                    duration INTEGER DEFAULT 0,
                    project TEXT NOT NULL,
                    language TEXT NOT NULL,
                    file TEXT NOT NULL,
                    branch TEXT,
                    is_active INTEGER DEFAULT 1,
                    heartbeats INTEGER DEFAULT 0,
                    keystrokes INTEGER DEFAULT 0,
                    lines_added INTEGER DEFAULT 0,
                    lines_removed INTEGER DEFAULT 0,
                    productivity_score REAL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
        await this.run(`
                CREATE TABLE IF NOT EXISTS activities (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    file TEXT,
                    language TEXT,
                    project TEXT,
                    session_id TEXT,
                    is_idle INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
        await this.run('CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time)');
        await this.run('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)');
        await this.run('CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities(timestamp)');
    }
    async migrateToV2() {
        await this.addColumnIfMissing('sessions', 'idle_duration', 'INTEGER DEFAULT 0');
        await this.addColumnIfMissing('activities', 'session_id', 'TEXT');
        await this.addColumnIfMissing('activities', 'is_idle', 'INTEGER DEFAULT 0');
        await this.run('UPDATE sessions SET idle_duration = 0 WHERE idle_duration IS NULL');
        await this.run('CREATE INDEX IF NOT EXISTS idx_activities_session_id ON activities(session_id)');
    }
    async migrateToV3() {
        await this.run(`
                CREATE TABLE IF NOT EXISTS session_segments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    segment_type TEXT NOT NULL,
                    start_time TEXT NOT NULL,
                    end_time TEXT,
                    duration INTEGER DEFAULT 0,
                    project TEXT NOT NULL,
                    language TEXT NOT NULL,
                    file TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
                )
            `);
        await this.run(`
                CREATE TABLE IF NOT EXISTS daily_rollups (
                    date TEXT PRIMARY KEY,
                    total_time INTEGER DEFAULT 0,
                    idle_time INTEGER DEFAULT 0,
                    session_count INTEGER DEFAULT 0,
                    keystrokes INTEGER DEFAULT 0,
                    lines_added INTEGER DEFAULT 0,
                    lines_removed INTEGER DEFAULT 0,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
    }
    async migrateToV4() {
        await this.addColumnIfMissing('sessions', 'tags', 'TEXT DEFAULT "[]"');
        await this.run('UPDATE sessions SET tags = COALESCE(tags, "[]") WHERE tags IS NULL');
    }
    async migrateToV5() {
        for (const statement of schema_v5_1.MIGRATION_V5_STATEMENTS) {
            await this.run(statement);
        }
    }
    async migrateToV6() {
        await this.addColumnIfMissing('ai_tool_events', 'envelope_id', 'TEXT');
        await this.addColumnIfMissing('ai_token_usage', 'envelope_id', 'TEXT');
        for (const statement of schema_v5_1.MIGRATION_V6_STATEMENTS) {
            await this.run(statement);
        }
    }
    async migrateToV7() {
        await this.addColumnIfMissing('ai_sessions', 'last_activity_at', 'TEXT');
        await this.addColumnIfMissing('ai_sessions', 'active_duration', 'INTEGER DEFAULT 0');
        for (const statement of schema_v5_1.MIGRATION_V7_STATEMENTS) {
            await this.run(statement);
        }
    }
    async migrateToV8() {
        for (const statement of schema_v5_1.MIGRATION_V8_STATEMENTS) {
            await this.run(statement);
        }
    }
    async setSchemaVersion(version) {
        await this.run(`
                UPDATE meta
                SET value = ?
                WHERE key = 'schema_version'
            `, [String(version)]);
    }
    async addColumnIfMissing(tableName, columnName, columnSql) {
        const columns = await this.all(`PRAGMA table_info(${tableName})`);
        if (!columns.some(column => column.name === columnName)) {
            await this.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`);
        }
    }
    getDb() {
        if (!this.db) {
            throw new Error('Database is not open');
        }
        return this.db;
    }
    /**
     * Runs `fn` inside a BEGIN IMMEDIATE … COMMIT transaction, serialized
     * through the shared write queue with every other write entry point —
     * interleaved BEGINs on the same handle would otherwise fail with
     * "cannot start a transaction within a transaction", and a stray write
     * between BEGIN and COMMIT would silently join the open transaction.
     */
    withTransaction(fn) {
        return this.enqueueWrite(async () => {
            await this.run('BEGIN IMMEDIATE');
            try {
                const result = await fn();
                await this.run('COMMIT');
                return result;
            }
            catch (error) {
                try {
                    await this.run('ROLLBACK');
                }
                catch {
                    // Connection-level failure — surface the original error.
                }
                throw error;
            }
        });
    }
    /**
     * Serializes one TOP-LEVEL write through the shared queue. All writers
     * share a single connection, so a statement issued between another
     * caller's BEGIN IMMEDIATE and COMMIT would silently join that open
     * transaction and die with its rollback. Statements already running
     * inside a queued write (an open transaction's own internals) execute
     * directly — re-queueing them would deadlock the chain on itself.
     */
    enqueueWrite(fn) {
        if (this.writeScope.getStore()) {
            return fn();
        }
        const task = this.writeQueue.then(() => this.writeScope.run(true, fn));
        this.writeQueue = task.then(() => undefined, () => undefined);
        return task;
    }
    /**
     * Write-path statement helper — funnels through the write queue so no
     * mutation can interleave into an open transaction. Reads (`get`/`all`)
     * stay unqueued.
     */
    run(sql, params = []) {
        return this.enqueueWrite(() => this.runStatement(sql, params));
    }
    runStatement(sql, params) {
        return new Promise((resolve, reject) => {
            this.getDb().run(sql, params, function (error) {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(this);
            });
        });
    }
    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.getDb().get(sql, params, (error, row) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(row ?? null);
            });
        });
    }
    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.getDb().all(sql, params, (error, rows) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(rows ?? []);
            });
        });
    }
}
exports.DatabaseV5 = DatabaseV5;
function clampListParam(value, max, fallback) {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(1, Math.trunc(value)));
}
/** Formats a Date as its local YYYY-MM-DD day, matching SQLite date(x, 'localtime'). */
function formatLocalDay(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
/** Returns the local midnight that starts the calendar day containing ms. */
function localMidnightMs(ms) {
    const date = new Date(ms);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
/**
 * Splits [startMs, endMs] across the local calendar days it touches, crediting
 * each day with only the portion inside its local midnight-to-midnight window
 * (computed via local Date components, so DST-shifted days keep wall-clock
 * boundaries). A degenerate span (endMs <= startMs) yields its start day with
 * zero run so the session still counts once.
 */
function splitSpanByLocalDay(startMs, endMs) {
    const clampedEndMs = Math.max(startMs, endMs);
    const slices = [];
    const start = new Date(startMs);
    let dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    for (;;) {
        const nextDayStart = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);
        const overlapMs = Math.min(clampedEndMs, nextDayStart.getTime()) - Math.max(startMs, dayStart.getTime());
        slices.push({ day: formatLocalDay(dayStart), runMs: Math.max(0, overlapMs) });
        if (clampedEndMs <= nextDayStart.getTime()) {
            return slices;
        }
        dayStart = nextDayStart;
    }
}
/** Plain code-unit comparison, matching SQLite's BINARY ORDER BY for our keys. */
function compareAscii(a, b) {
    if (a < b) {
        return -1;
    }
    return a > b ? 1 : 0;
}
const SOURCE_BY_EVIDENCE_TYPE = {
    process: 'process',
    log_line: 'log',
    hook_event: 'hook',
    extension_report: 'extension',
    terminal: 'terminal'
};
/**
 * Derives the ai_sessions source label from a detection's evidence — the
 * envelope src alone cannot distinguish process-watcher detections from hook
 * forwards (both arrive as src 'scanner'). Evidence-less scanner envelopes
 * default to 'process' (the global watcher).
 */
function resolveDetectionSource(src, evidence) {
    for (const item of evidence) {
        const mapped = SOURCE_BY_EVIDENCE_TYPE[item.type];
        if (mapped) {
            return mapped;
        }
    }
    return src === 'scanner' ? 'process' : src;
}
function nextDay(day) {
    const date = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid day format: ${day}`);
    }
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
}
//# sourceMappingURL=DatabaseV5.js.map