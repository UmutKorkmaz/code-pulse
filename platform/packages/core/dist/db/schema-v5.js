"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIGRATION_V8_STATEMENTS = exports.MIGRATION_V7_STATEMENTS = exports.MIGRATION_V6_STATEMENTS = exports.MIGRATION_V5_STATEMENTS = exports.SCHEMA_VERSION = void 0;
/** Daemon-owned SQLite schema version (extends extension schema v4). */
exports.SCHEMA_VERSION = 8;
/**
 * v5 migration: AI analytics, snapshots, registry cursors, and privacy audit.
 * Applied on top of sessions/activities schema from v1–v4.
 */
exports.MIGRATION_V5_STATEMENTS = [
    `
        CREATE TABLE IF NOT EXISTS ai_sessions (
            id TEXT PRIMARY KEY,
            session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
            scanner_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            model TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            confidence REAL DEFAULT 1.0,
            source TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `,
    `
        CREATE TABLE IF NOT EXISTS ai_tool_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ai_session_id TEXT REFERENCES ai_sessions(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            tool TEXT NOT NULL,
            metadata TEXT,
            occurred_at TEXT NOT NULL,
            envelope_id TEXT
        )
    `,
    `
        CREATE TABLE IF NOT EXISTS ai_token_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ai_session_id TEXT REFERENCES ai_sessions(id) ON DELETE CASCADE,
            model TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cache_read_tokens INTEGER DEFAULT 0,
            cache_write_tokens INTEGER DEFAULT 0,
            estimated INTEGER DEFAULT 0,
            recorded_at TEXT NOT NULL,
            envelope_id TEXT
        )
    `,
    `
        CREATE TABLE IF NOT EXISTS file_snapshots (
            id TEXT PRIMARY KEY,
            ai_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL,
            session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
            project TEXT NOT NULL,
            file_path TEXT NOT NULL,
            snapshot_type TEXT NOT NULL,
            diff_path TEXT,
            file_hash_before TEXT,
            file_hash_after TEXT,
            size_bytes INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `,
    `
        CREATE TABLE IF NOT EXISTS registry_scanners (
            id TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            trust TEXT NOT NULL,
            enabled INTEGER DEFAULT 0,
            installed_at TEXT,
            last_scan_at TEXT,
            manifest_hash TEXT NOT NULL
        )
    `,
    `
        CREATE TABLE IF NOT EXISTS parser_cursors (
            scanner_id TEXT NOT NULL,
            log_glob TEXT NOT NULL,
            byte_offset INTEGER DEFAULT 0,
            inode TEXT,
            last_event_id TEXT,
            PRIMARY KEY (scanner_id, log_glob)
        )
    `,
    `
        CREATE TABLE IF NOT EXISTS privacy_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor TEXT NOT NULL,
            operation TEXT NOT NULL,
            target_hash TEXT,
            occurred_at TEXT NOT NULL
        )
    `,
    'CREATE INDEX IF NOT EXISTS idx_ai_sessions_session ON ai_sessions(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_ai_sessions_tool ON ai_sessions(tool)',
    'CREATE INDEX IF NOT EXISTS idx_snapshots_ai_session ON file_snapshots(ai_session_id)',
    'CREATE INDEX IF NOT EXISTS idx_snapshots_file ON file_snapshots(file_path)',
    'CREATE INDEX IF NOT EXISTS idx_token_usage_ai_session ON ai_token_usage(ai_session_id)',
    'CREATE INDEX IF NOT EXISTS idx_privacy_audit_occurred ON privacy_audit(occurred_at)'
];
/**
 * v6 migration: indexed envelope dedup. The envelope_id columns are added via
 * the idempotent addColumnIfMissing path (no backfill — historical rows keep
 * NULL, which SQLite UNIQUE indexes treat as distinct); these statements add
 * the unique indexes that INSERT OR IGNORE dedup relies on.
 */
exports.MIGRATION_V6_STATEMENTS = [
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_tool_events_envelope_id ON ai_tool_events(envelope_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_envelope_id ON ai_token_usage(envelope_id)'
];
/**
 * v7 migration: AI activity tracking. The last_activity_at / active_duration
 * columns are added via the idempotent addColumnIfMissing path (historical
 * rows keep NULL last_activity_at — the accumulator treats their next event
 * as a fresh window); these statements normalize active_duration and index
 * open sessions for the stale-session sweep.
 */
exports.MIGRATION_V7_STATEMENTS = [
    'UPDATE ai_sessions SET active_duration = 0 WHERE active_duration IS NULL',
    'CREATE INDEX IF NOT EXISTS idx_ai_sessions_ended_at ON ai_sessions(ended_at)'
];
/**
 * v8 migration: exact per-day active-time buckets. Each credited activity
 * interval is split across the local calendar days it covers and upserted
 * here, so day aggregates no longer attribute a session's whole
 * active_duration to the day of its last activity. ai_sessions.active_duration
 * stays the session running total (both are written going forward; rows
 * predating v8 have no daily buckets — their active time starts at zero).
 */
exports.MIGRATION_V8_STATEMENTS = [
    `
        CREATE TABLE IF NOT EXISTS ai_activity_daily (
            ai_session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
            day TEXT NOT NULL,
            active_seconds INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (ai_session_id, day)
        )
    `,
    'CREATE INDEX IF NOT EXISTS idx_ai_activity_daily_day ON ai_activity_daily(day)'
];
//# sourceMappingURL=schema-v5.js.map