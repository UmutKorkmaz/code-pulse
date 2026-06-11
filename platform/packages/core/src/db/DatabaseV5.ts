import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import * as sqlite3 from 'sqlite3';
import type { AnyEnvelope, Evidence } from '@codepulse/protocol';
import {
    MIGRATION_V5_STATEMENTS,
    MIGRATION_V6_STATEMENTS,
    MIGRATION_V7_STATEMENTS,
    MIGRATION_V8_STATEMENTS,
    SCHEMA_VERSION
} from './schema-v5';

export interface AiSessionRow {
    id: string;
    session_id: string | null;
    scanner_id: string;
    tool: string;
    model: string | null;
    started_at: string;
    ended_at: string | null;
    confidence: number;
    source: string | null;
    /** ISO timestamp of the most recent activity event attached to this session. */
    last_activity_at: string | null;
    /** Gap-windowed active work time in seconds — session running total (per-day buckets live in ai_activity_daily). */
    active_duration: number;
    created_at: string;
}

/**
 * Insert shape for ai_sessions — activity columns are owned by the ingest
 * accumulator (start NULL / 0) and are never supplied at insert time.
 */
export type AiSessionInsert = Omit<
    AiSessionRow,
    'created_at' | 'last_activity_at' | 'active_duration'
>;

export interface AiTokenUsageRow {
    id: number;
    ai_session_id: string;
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    estimated: number;
    recorded_at: string;
    /** Source envelope id — unique-indexed so envelope replays dedup. */
    envelope_id: string | null;
}

export interface FileSnapshotRow {
    id: string;
    ai_session_id: string | null;
    session_id: string | null;
    project: string;
    file_path: string;
    snapshot_type: string;
    diff_path: string | null;
    file_hash_before: string | null;
    file_hash_after: string | null;
    size_bytes: number | null;
    created_at: string;
}

export interface RegistryScannerRow {
    id: string;
    version: string;
    trust: string;
    enabled: number;
    installed_at: string | null;
    last_scan_at: string | null;
    manifest_hash: string;
}

export interface ParserCursorRow {
    scanner_id: string;
    log_glob: string;
    byte_offset: number;
    inode: string | null;
    last_event_id: string | null;
}

export interface PrivacyAuditRow {
    id: number;
    actor: string;
    operation: string;
    target_hash: string | null;
    occurred_at: string;
}

export interface ListSnapshotsFilter {
    aiSessionId?: string;
    sessionId?: string;
    project?: string;
    snapshotType?: string;
    limit?: number;
    offset?: number;
}

export interface TokenUsageAggregate {
    day: string;
    tool: string;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    estimatedRows: number;
}

export interface AiToolEventRow {
    id: number;
    ai_session_id: string | null;
    event_type: string;
    tool: string;
    metadata: string | null;
    occurred_at: string;
    /** Source envelope id — unique-indexed so envelope replays dedup. */
    envelope_id: string | null;
}

/** Coding session persisted by ingestEnvelopeFromSpool (sessions table). */
export interface SessionRow {
    id: string;
    start_time: string;
    end_time: string | null;
    duration: number;
    idle_duration: number;
    project: string;
    language: string;
    file: string;
    branch: string | null;
    is_active: number;
    heartbeats: number;
    keystrokes: number;
    lines_added: number;
    lines_removed: number;
    productivity_score: number | null;
    /** JSON-encoded string array. */
    tags: string;
    created_at: string;
    updated_at: string;
}

export interface ListSessionsOptions {
    days?: number;
    limit?: number;
}

export interface ListAiActivityOptions {
    days?: number;
}

/** One local-day × tool aggregate of AI run/active time and token usage. */
export interface AiActivityByDayRow {
    /** Local calendar day (YYYY-MM-DD) the activity fell on. */
    day: string;
    tool: string;
    /** Wall-clock run time in ms — each session's [started_at, ended_at ?? now] portion inside this day. */
    runMs: number;
    /** Gap-windowed active time in ms — the exact portion credited to this day (ai_activity_daily). */
    activeMs: number;
    /** Number of sessions whose run span overlaps this day. */
    sessions: number;
    inputTokens: number;
    outputTokens: number;
}

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

export class DatabaseV5 {
    private db: sqlite3.Database | null = null;
    private readonly dbPath: string;
    private writeQueue: Promise<void> = Promise.resolve();
    /**
     * Marks async call chains already executing inside a queued write —
     * AsyncLocalStorage (not a boolean flag) because the marker must follow
     * the async chain across awaits, where interleaved outside callers would
     * otherwise observe a stale flag and bypass the queue.
     */
    private readonly writeScope = new AsyncLocalStorage<true>();

    constructor(dataDir: string, dbFileName = 'codepulse.db') {
        this.dbPath = path.join(dataDir, dbFileName);
    }

    get path(): string {
        return this.dbPath;
    }

    async open(): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true });

        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, async error => {
                if (error) {
                    reject(new Error(`Failed to open database: ${error.message}`));
                    return;
                }

                try {
                    await this.run('PRAGMA foreign_keys = ON');
                    await this.run('PRAGMA busy_timeout = 5000');
                    await this.migrate();
                    resolve();
                } catch (migrateError) {
                    reject(migrateError);
                }
            });
        });
    }

    async close(): Promise<void> {
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

    async getSchemaVersion(): Promise<number> {
        const row = await this.get<{ value: string }>(
            `SELECT value FROM meta WHERE key = 'schema_version'`
        );
        return Number(row?.value ?? '0');
    }

    async migrate(): Promise<void> {
        await this.run(
            `
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            `
        );

        await this.run(
            `
                INSERT OR IGNORE INTO meta (key, value)
                VALUES ('schema_version', '0')
            `
        );

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

        if (currentVersion < SCHEMA_VERSION) {
            await this.migrateToV8();
            currentVersion = SCHEMA_VERSION;
            await this.setSchemaVersion(currentVersion);
        }
    }

    async insertAiSession(session: AiSessionInsert): Promise<void> {
        await this.run(
            `
                INSERT INTO ai_sessions (
                    id, session_id, scanner_id, tool, model, started_at, ended_at, confidence, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                session.id,
                session.session_id,
                session.scanner_id,
                session.tool,
                session.model,
                session.started_at,
                session.ended_at,
                session.confidence,
                session.source
            ]
        );
    }

    /** Idempotent insert — ignores duplicate primary keys (scanner races / log replay). */
    async insertAiSessionIfNotExists(session: AiSessionInsert): Promise<boolean> {
        const result = await this.run(
            `
                INSERT OR IGNORE INTO ai_sessions (
                    id, session_id, scanner_id, tool, model, started_at, ended_at, confidence, source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                session.id,
                session.session_id,
                session.scanner_id,
                session.tool,
                session.model,
                session.started_at,
                session.ended_at,
                session.confidence,
                session.source
            ]
        );
        return (result.changes ?? 0) > 0;
    }

    async getAiSession(id: string): Promise<AiSessionRow | null> {
        return this.get<AiSessionRow>('SELECT * FROM ai_sessions WHERE id = ?', [id]);
    }

    /**
     * Lists AI sessions newest first. `limit` is clamped (default 50, max
     * 1000); rows include last_activity_at + active_duration so callers can
     * derive activeDurationMs / lastActivityAt / isActive.
     */
    async listAiSessions(
        limit = AI_SESSION_LIST_DEFAULT_LIMIT,
        offset = 0
    ): Promise<AiSessionRow[]> {
        const clampedLimit = clampListParam(
            limit,
            AI_SESSION_LIST_MAX_LIMIT,
            AI_SESSION_LIST_DEFAULT_LIMIT
        );
        const clampedOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
        return this.all<AiSessionRow>(
            'SELECT * FROM ai_sessions ORDER BY started_at DESC LIMIT ? OFFSET ?',
            [clampedLimit, clampedOffset]
        );
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
    async listAiActivityByDay(opts: ListAiActivityOptions = {}): Promise<AiActivityByDayRow[]> {
        const days = clampListParam(opts.days, SESSION_LIST_MAX_DAYS, SESSION_LIST_DEFAULT_DAYS);
        const nowMs = Date.now();
        const sinceMs = localMidnightMs(nowMs - days * DAY_MS);
        const nowIso = new Date(nowMs).toISOString();
        const sinceIso = new Date(sinceMs).toISOString();

        const sessionRows = await this.all<{
            tool: string;
            started_at: string;
            ended_at: string | null;
        }>(
            `
                SELECT tool, started_at, ended_at
                FROM ai_sessions
                WHERE COALESCE(ended_at, ?) >= ?
            `,
            [nowIso, sinceIso]
        );

        const buckets = new Map<string, AiActivityByDayRow>();
        const bucketFor = (day: string, tool: string): AiActivityByDayRow => {
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
            const spanEndMs = Math.max(
                spanStartMs,
                Math.min(Number.isFinite(endedMs) ? endedMs : nowMs, nowMs)
            );

            for (const slice of splitSpanByLocalDay(spanStartMs, spanEndMs)) {
                const bucket = bucketFor(slice.day, session.tool);
                bucket.runMs += slice.runMs;
                bucket.sessions += 1;
            }
        }

        const activeRows = await this.all<{
            day: string;
            tool: string;
            active_seconds: number;
        }>(
            `
                SELECT
                    d.day AS day,
                    s.tool AS tool,
                    COALESCE(SUM(d.active_seconds), 0) AS active_seconds
                FROM ai_activity_daily d
                INNER JOIN ai_sessions s ON s.id = d.ai_session_id
                WHERE d.day >= ? AND d.day <= ?
                GROUP BY d.day, s.tool
            `,
            [formatLocalDay(new Date(sinceMs)), formatLocalDay(new Date(nowMs))]
        );
        for (const row of activeRows) {
            bucketFor(row.day, row.tool).activeMs += Math.round(row.active_seconds * 1000);
        }

        const tokenRows = await this.all<{
            day: string;
            tool: string;
            input_tokens: number;
            output_tokens: number;
        }>(
            `
                SELECT
                    date(u.recorded_at, 'localtime') AS day,
                    s.tool AS tool,
                    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
                    COALESCE(SUM(u.output_tokens), 0) AS output_tokens
                FROM ai_token_usage u
                INNER JOIN ai_sessions s ON s.id = u.ai_session_id
                WHERE u.recorded_at >= ?
                GROUP BY day, tool
            `,
            [sinceIso]
        );
        for (const row of tokenRows) {
            const bucket = bucketFor(row.day, row.tool);
            bucket.inputTokens += row.input_tokens;
            bucket.outputTokens += row.output_tokens;
        }

        return [...buckets.values()].sort(
            (a, b) => compareAscii(a.day, b.day) || compareAscii(a.tool, b.tool)
        );
    }

    /**
     * Closes open AI sessions whose last observed activity (falling back to
     * started_at) is older than the cutoff, setting ended_at to that
     * last-activity time. Returns the number of sessions closed.
     */
    async endStaleAiSessions(olderThanMinutes: number): Promise<number> {
        if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0) {
            throw new Error(`olderThanMinutes must be a non-negative number: ${olderThanMinutes}`);
        }
        const cutoffIso = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
        const result = await this.run(
            `
                UPDATE ai_sessions
                SET ended_at = COALESCE(last_activity_at, started_at)
                WHERE ended_at IS NULL
                  AND COALESCE(last_activity_at, started_at) < ?
            `,
            [cutoffIso]
        );
        return result.changes ?? 0;
    }

    /**
     * Lists coding sessions (persisted by ingestEnvelopeFromSpool) that
     * started within the last `days` days, newest first. Both params are
     * clamped to sane bounds — negatives and zero floor to 1, oversized
     * values cap at 90 days / 1000 rows.
     */
    async listSessions(options: ListSessionsOptions = {}): Promise<SessionRow[]> {
        const days = clampListParam(options.days, SESSION_LIST_MAX_DAYS, SESSION_LIST_DEFAULT_DAYS);
        const limit = clampListParam(
            options.limit,
            SESSION_LIST_MAX_LIMIT,
            SESSION_LIST_DEFAULT_LIMIT
        );
        const since = new Date(Date.now() - days * DAY_MS).toISOString();

        return this.all<SessionRow>(
            `
                SELECT * FROM sessions
                WHERE start_time >= ?
                ORDER BY start_time DESC
                LIMIT ?
            `,
            [since, limit]
        );
    }

    async insertAiTokenUsage(
        usage: Omit<AiTokenUsageRow, 'id'>
    ): Promise<number> {
        const result = await this.run(
            `
                INSERT INTO ai_token_usage (
                    ai_session_id, model, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, estimated, recorded_at, envelope_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                usage.ai_session_id,
                usage.model,
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_read_tokens,
                usage.cache_write_tokens,
                usage.estimated,
                usage.recorded_at,
                usage.envelope_id
            ]
        );
        return result.lastID;
    }

    /**
     * Idempotent variant for envelope ingest — INSERT OR IGNORE against the
     * unique envelope_id index. Returns false when the envelope was already
     * recorded (replayed log line / spool re-read).
     */
    private async insertAiTokenUsageIfNew(usage: Omit<AiTokenUsageRow, 'id'>): Promise<boolean> {
        const result = await this.run(
            `
                INSERT OR IGNORE INTO ai_token_usage (
                    ai_session_id, model, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, estimated, recorded_at, envelope_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                usage.ai_session_id,
                usage.model,
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_read_tokens,
                usage.cache_write_tokens,
                usage.estimated,
                usage.recorded_at,
                usage.envelope_id
            ]
        );
        return (result.changes ?? 0) > 0;
    }

    async listAiTokenUsage(aiSessionId: string): Promise<AiTokenUsageRow[]> {
        return this.all<AiTokenUsageRow>(
            'SELECT * FROM ai_token_usage WHERE ai_session_id = ? ORDER BY recorded_at ASC',
            [aiSessionId]
        );
    }

    async insertFileSnapshot(snapshot: Omit<FileSnapshotRow, 'created_at'>): Promise<void> {
        await this.run(
            `
                INSERT INTO file_snapshots (
                    id, ai_session_id, session_id, project, file_path, snapshot_type,
                    diff_path, file_hash_before, file_hash_after, size_bytes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
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
            ]
        );
    }

    async getFileSnapshot(id: string): Promise<FileSnapshotRow | null> {
        return this.get<FileSnapshotRow>('SELECT * FROM file_snapshots WHERE id = ?', [id]);
    }

    async listFileSnapshots(filter: ListSnapshotsFilter = {}): Promise<FileSnapshotRow[]> {
        const clauses: string[] = [];
        const params: unknown[] = [];

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

        return this.all<FileSnapshotRow>(
            `
                SELECT * FROM file_snapshots
                ${where}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
            `,
            [...params, limit, offset]
        );
    }

    async upsertRegistryScanner(scanner: RegistryScannerRow): Promise<void> {
        await this.run(
            `
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
            `,
            [
                scanner.id,
                scanner.version,
                scanner.trust,
                scanner.enabled,
                scanner.installed_at,
                scanner.last_scan_at,
                scanner.manifest_hash
            ]
        );
    }

    async touchRegistryScannerLastScan(scannerId: string, lastScanAt: string): Promise<void> {
        await this.run(
            `
                UPDATE registry_scanners
                SET last_scan_at = ?
                WHERE id = ?
            `,
            [lastScanAt, scannerId]
        );
    }

    async listRegistryScanners(): Promise<RegistryScannerRow[]> {
        return this.all<RegistryScannerRow>('SELECT * FROM registry_scanners ORDER BY id ASC');
    }

    async endAiSession(id: string, endedAt: string): Promise<boolean> {
        const result = await this.run(
            `
                UPDATE ai_sessions
                SET ended_at = ?
                WHERE id = ? AND ended_at IS NULL
            `,
            [endedAt, id]
        );
        return (result.changes ?? 0) > 0;
    }

    async upsertParserCursor(cursor: ParserCursorRow): Promise<void> {
        await this.run(
            `
                INSERT INTO parser_cursors (
                    scanner_id, log_glob, byte_offset, inode, last_event_id
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(scanner_id, log_glob) DO UPDATE SET
                    byte_offset = excluded.byte_offset,
                    inode = excluded.inode,
                    last_event_id = excluded.last_event_id
            `,
            [
                cursor.scanner_id,
                cursor.log_glob,
                cursor.byte_offset,
                cursor.inode,
                cursor.last_event_id
            ]
        );
    }

    async getParserCursor(scannerId: string, logGlob: string): Promise<ParserCursorRow | null> {
        return this.get<ParserCursorRow>(
            'SELECT * FROM parser_cursors WHERE scanner_id = ? AND log_glob = ?',
            [scannerId, logGlob]
        );
    }

    async insertPrivacyAudit(entry: Omit<PrivacyAuditRow, 'id'>): Promise<number> {
        const result = await this.run(
            `
                INSERT INTO privacy_audit (actor, operation, target_hash, occurred_at)
                VALUES (?, ?, ?, ?)
            `,
            [entry.actor, entry.operation, entry.target_hash, entry.occurred_at]
        );
        return result.lastID;
    }

    async listPrivacyAudit(limit = 100, offset = 0): Promise<PrivacyAuditRow[]> {
        return this.all<PrivacyAuditRow>(
            'SELECT * FROM privacy_audit ORDER BY occurred_at DESC LIMIT ? OFFSET ?',
            [limit, offset]
        );
    }

    async aggregateTokenUsageByDay(day: string): Promise<TokenUsageAggregate[]> {
        const rows = await this.all<{
            tool: string;
            model: string | null;
            input_tokens: number;
            output_tokens: number;
            cache_read_tokens: number;
            cache_write_tokens: number;
            estimated_rows: number;
        }>(
            `
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
            `,
            [`${day}T00:00:00.000Z`, `${nextDay(day)}T00:00:00.000Z`]
        );

        return rows.map(row => ({
            day,
            tool: row.tool,
            model: row.model,
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            cacheReadTokens: row.cache_read_tokens,
            cacheWriteTokens: row.cache_write_tokens,
            totalTokens:
                row.input_tokens +
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
    async ingestEnvelopeFromSpool(envelope: AnyEnvelope): Promise<boolean> {
        return this.withTransaction(() => this.ingestEnvelopeInTransaction(envelope));
    }

    /**
     * Atomically ingests a parsed-log batch and persists its parser cursor in
     * ONE transaction — a crash mid-batch can never advance the cursor past
     * unrecorded events or record events the cursor will replay. Returns the
     * envelopes that were newly ingested (replays are filtered out).
     */
    async ingestLogBatchWithCursor(
        envelopes: AnyEnvelope[],
        cursor: ParserCursorRow
    ): Promise<AnyEnvelope[]> {
        return this.withTransaction(async () => {
            const ingested: AnyEnvelope[] = [];
            for (const envelope of envelopes) {
                if (await this.ingestEnvelopeInTransaction(envelope)) {
                    ingested.push(envelope);
                }
            }
            await this.upsertParserCursor(cursor);
            return ingested;
        });
    }

    private async ingestEnvelopeInTransaction(envelope: AnyEnvelope): Promise<boolean> {
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

    private async ingestSessionStartedEnvelope(envelope: AnyEnvelope): Promise<boolean> {
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
        const startedAt = await this.clampStartToLastEnded(
            session.scannerId,
            session.tool,
            session.startedAt
        );

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
            await this.accumulateAiActivity(
                session.id,
                Number.isFinite(startedAtMs) ? startedAtMs : envelope.ts
            );
        }
        return inserted;
    }

    private async ingestSessionEndedEnvelope(envelope: AnyEnvelope): Promise<boolean> {
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
    private async ingestCodingSessionEnvelope(
        envelope: AnyEnvelope,
        markEnded: boolean
    ): Promise<boolean> {
        const payload = envelope.payload;
        if (payload.type !== 'session.updated' && payload.type !== 'session.ended') {
            return false;
        }

        const session = payload.session;
        const endTime = markEnded
            ? session.endTime ?? new Date(envelope.ts).toISOString()
            : session.endTime ?? null;
        const isActive = markEnded ? 0 : session.isActive ? 1 : 0;

        await this.run(
            `
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
            `,
            [
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
            ]
        );
        return true;
    }

    private async ingestToolDetectedEnvelope(envelope: AnyEnvelope): Promise<boolean> {
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
        const startedAt = new Date(
            Math.max(envelope.ts, Date.now() - DETECTION_STARTED_AT_FLOOR_MS)
        ).toISOString();
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

    private async ingestTokensEnvelope(envelope: AnyEnvelope): Promise<boolean> {
        const payload = envelope.payload;
        if (payload.type !== 'ai.tokens') {
            return false;
        }

        const usage = payload.usage;
        const scannerId = usage.scannerId ?? envelope.src;
        const tool = usage.tool ?? 'unknown';
        const occurredAt = new Date(envelope.ts).toISOString();
        const aiSessionId = await this.resolveAiSessionIdForUsage(
            envelope.id,
            usage.aiSessionId,
            scannerId,
            tool,
            occurredAt,
            usage.model ?? null,
            usage.isEstimated ? 0.8 : 1
        );

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
    private async accumulateAiActivity(aiSessionId: string, occurredAtMs: number): Promise<void> {
        if (!Number.isFinite(occurredAtMs)) {
            return;
        }

        const row = await this.get<{
            started_at: string;
            last_activity_at: string | null;
            active_duration: number | null;
        }>('SELECT started_at, last_activity_at, active_duration FROM ai_sessions WHERE id = ?', [
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

        await this.run(
            `
                UPDATE ai_sessions
                SET active_duration = COALESCE(active_duration, 0) + ?,
                    last_activity_at = ?
                WHERE id = ?
            `,
            [grantSeconds, new Date(occurredAtMs).toISOString(), aiSessionId]
        );

        for (const slice of splitSpanByLocalDay(creditStartMs, occurredAtMs)) {
            if (slice.runMs <= 0) {
                continue;
            }
            await this.run(
                `
                    INSERT INTO ai_activity_daily (ai_session_id, day, active_seconds)
                    VALUES (?, ?, ?)
                    ON CONFLICT(ai_session_id, day) DO UPDATE SET
                        active_seconds = active_seconds + excluded.active_seconds
                `,
                [aiSessionId, slice.day, slice.runMs / 1000]
            );
        }
    }

    private async resolveAiSessionIdForUsage(
        envelopeId: string,
        aiSessionId: string | undefined,
        scannerId: string,
        tool: string,
        startedAt: string,
        model: string | null,
        confidence: number
    ): Promise<string> {
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
    private async clampStartToLastEnded(
        scannerId: string,
        tool: string,
        startedAt: string
    ): Promise<string> {
        const row = await this.get<{ last_ended_at: string | null }>(
            `
                SELECT MAX(ended_at) AS last_ended_at
                FROM ai_sessions
                WHERE scanner_id = ? AND tool = ? AND ended_at IS NOT NULL
            `,
            [scannerId, tool]
        );
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

    private async findActiveAiSession(
        scannerId: string,
        tool: string
    ): Promise<AiSessionRow | null> {
        return this.get<AiSessionRow>(
            `
                SELECT * FROM ai_sessions
                WHERE scanner_id = ? AND tool = ? AND ended_at IS NULL
                ORDER BY started_at DESC
                LIMIT 1
            `,
            [scannerId, tool]
        );
    }

    /**
     * INSERT OR IGNORE against the unique envelope_id index — returns false
     * when this envelope's event was already recorded (replay).
     */
    private async insertAiToolEvent(
        event: Omit<AiToolEventRow, 'id'>
    ): Promise<boolean> {
        const result = await this.run(
            `
                INSERT OR IGNORE INTO ai_tool_events (
                    ai_session_id, event_type, tool, metadata, occurred_at, envelope_id
                ) VALUES (?, ?, ?, ?, ?, ?)
            `,
            [
                event.ai_session_id,
                event.event_type,
                event.tool,
                event.metadata,
                event.occurred_at,
                event.envelope_id
            ]
        );
        return (result.changes ?? 0) > 0;
    }

    private async migrateToV1(): Promise<void> {
        await this.run(
            `
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
            `
        );

        await this.run(
            `
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
            `
        );

        await this.run('CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time)');
        await this.run('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)');
        await this.run('CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities(timestamp)');
    }

    private async migrateToV2(): Promise<void> {
        await this.addColumnIfMissing('sessions', 'idle_duration', 'INTEGER DEFAULT 0');
        await this.addColumnIfMissing('activities', 'session_id', 'TEXT');
        await this.addColumnIfMissing('activities', 'is_idle', 'INTEGER DEFAULT 0');
        await this.run('UPDATE sessions SET idle_duration = 0 WHERE idle_duration IS NULL');
        await this.run('CREATE INDEX IF NOT EXISTS idx_activities_session_id ON activities(session_id)');
    }

    private async migrateToV3(): Promise<void> {
        await this.run(
            `
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
            `
        );

        await this.run(
            `
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
            `
        );
    }

    private async migrateToV4(): Promise<void> {
        await this.addColumnIfMissing('sessions', 'tags', 'TEXT DEFAULT "[]"');
        await this.run('UPDATE sessions SET tags = COALESCE(tags, "[]") WHERE tags IS NULL');
    }

    private async migrateToV5(): Promise<void> {
        for (const statement of MIGRATION_V5_STATEMENTS) {
            await this.run(statement);
        }
    }

    private async migrateToV6(): Promise<void> {
        await this.addColumnIfMissing('ai_tool_events', 'envelope_id', 'TEXT');
        await this.addColumnIfMissing('ai_token_usage', 'envelope_id', 'TEXT');
        for (const statement of MIGRATION_V6_STATEMENTS) {
            await this.run(statement);
        }
    }

    private async migrateToV7(): Promise<void> {
        await this.addColumnIfMissing('ai_sessions', 'last_activity_at', 'TEXT');
        await this.addColumnIfMissing('ai_sessions', 'active_duration', 'INTEGER DEFAULT 0');
        for (const statement of MIGRATION_V7_STATEMENTS) {
            await this.run(statement);
        }
    }

    private async migrateToV8(): Promise<void> {
        for (const statement of MIGRATION_V8_STATEMENTS) {
            await this.run(statement);
        }
    }

    private async setSchemaVersion(version: number): Promise<void> {
        await this.run(
            `
                UPDATE meta
                SET value = ?
                WHERE key = 'schema_version'
            `,
            [String(version)]
        );
    }

    private async addColumnIfMissing(
        tableName: string,
        columnName: string,
        columnSql: string
    ): Promise<void> {
        const columns = await this.all<{ name: string }>(`PRAGMA table_info(${tableName})`);
        if (!columns.some(column => column.name === columnName)) {
            await this.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`);
        }
    }

    private getDb(): sqlite3.Database {
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
    private withTransaction<T>(fn: () => Promise<T>): Promise<T> {
        return this.enqueueWrite(async () => {
            await this.run('BEGIN IMMEDIATE');
            try {
                const result = await fn();
                await this.run('COMMIT');
                return result;
            } catch (error) {
                try {
                    await this.run('ROLLBACK');
                } catch {
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
    private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
        if (this.writeScope.getStore()) {
            return fn();
        }
        const task = this.writeQueue.then(() => this.writeScope.run(true, fn));
        this.writeQueue = task.then(
            () => undefined,
            () => undefined
        );
        return task;
    }

    /**
     * Write-path statement helper — funnels through the write queue so no
     * mutation can interleave into an open transaction. Reads (`get`/`all`)
     * stay unqueued.
     */
    private run(sql: string, params: unknown[] = []): Promise<sqlite3.RunResult> {
        return this.enqueueWrite(() => this.runStatement(sql, params));
    }

    private runStatement(sql: string, params: unknown[]): Promise<sqlite3.RunResult> {
        return new Promise((resolve, reject) => {
            this.getDb().run(sql, params, function (this: sqlite3.RunResult, error: Error | null) {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(this);
            });
        });
    }

    private get<T>(sql: string, params: unknown[] = []): Promise<T | null> {
        return new Promise((resolve, reject) => {
            this.getDb().get(sql, params, (error, row) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve((row as T | undefined) ?? null);
            });
        });
    }

    private all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        return new Promise((resolve, reject) => {
            this.getDb().all(sql, params, (error, rows) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve((rows as T[]) ?? []);
            });
        });
    }
}

function clampListParam(value: number | undefined, max: number, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(1, Math.trunc(value)));
}

interface LocalDaySlice {
    /** Local calendar day (YYYY-MM-DD), matching SQLite date(x, 'localtime'). */
    day: string;
    /** Portion of the span inside this day's local [00:00, 24:00) window, in ms. */
    runMs: number;
}

/** Formats a Date as its local YYYY-MM-DD day, matching SQLite date(x, 'localtime'). */
function formatLocalDay(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Returns the local midnight that starts the calendar day containing ms. */
function localMidnightMs(ms: number): number {
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
function splitSpanByLocalDay(startMs: number, endMs: number): LocalDaySlice[] {
    const clampedEndMs = Math.max(startMs, endMs);
    const slices: LocalDaySlice[] = [];
    const start = new Date(startMs);
    let dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());

    for (;;) {
        const nextDayStart = new Date(
            dayStart.getFullYear(),
            dayStart.getMonth(),
            dayStart.getDate() + 1
        );
        const overlapMs =
            Math.min(clampedEndMs, nextDayStart.getTime()) - Math.max(startMs, dayStart.getTime());
        slices.push({ day: formatLocalDay(dayStart), runMs: Math.max(0, overlapMs) });
        if (clampedEndMs <= nextDayStart.getTime()) {
            return slices;
        }
        dayStart = nextDayStart;
    }
}

/** Plain code-unit comparison, matching SQLite's BINARY ORDER BY for our keys. */
function compareAscii(a: string, b: string): number {
    if (a < b) {
        return -1;
    }
    return a > b ? 1 : 0;
}

const SOURCE_BY_EVIDENCE_TYPE: Readonly<Partial<Record<Evidence['type'], string>>> = {
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
function resolveDetectionSource(src: string, evidence: readonly Evidence[]): string {
    for (const item of evidence) {
        const mapped = SOURCE_BY_EVIDENCE_TYPE[item.type];
        if (mapped) {
            return mapped;
        }
    }
    return src === 'scanner' ? 'process' : src;
}

function nextDay(day: string): string {
    const date = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid day format: ${day}`);
    }
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
}
