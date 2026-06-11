/** Daemon-owned SQLite schema version (extends extension schema v4). */
export declare const SCHEMA_VERSION = 8;
/**
 * v5 migration: AI analytics, snapshots, registry cursors, and privacy audit.
 * Applied on top of sessions/activities schema from v1–v4.
 */
export declare const MIGRATION_V5_STATEMENTS: readonly string[];
/**
 * v6 migration: indexed envelope dedup. The envelope_id columns are added via
 * the idempotent addColumnIfMissing path (no backfill — historical rows keep
 * NULL, which SQLite UNIQUE indexes treat as distinct); these statements add
 * the unique indexes that INSERT OR IGNORE dedup relies on.
 */
export declare const MIGRATION_V6_STATEMENTS: readonly string[];
/**
 * v7 migration: AI activity tracking. The last_activity_at / active_duration
 * columns are added via the idempotent addColumnIfMissing path (historical
 * rows keep NULL last_activity_at — the accumulator treats their next event
 * as a fresh window); these statements normalize active_duration and index
 * open sessions for the stale-session sweep.
 */
export declare const MIGRATION_V7_STATEMENTS: readonly string[];
/**
 * v8 migration: exact per-day active-time buckets. Each credited activity
 * interval is split across the local calendar days it covers and upserted
 * here, so day aggregates no longer attribute a session's whole
 * active_duration to the day of its last activity. ai_sessions.active_duration
 * stays the session running total (both are written going forward; rows
 * predating v8 have no daily buckets — their active time starts at zero).
 */
export declare const MIGRATION_V8_STATEMENTS: readonly string[];
//# sourceMappingURL=schema-v5.d.ts.map