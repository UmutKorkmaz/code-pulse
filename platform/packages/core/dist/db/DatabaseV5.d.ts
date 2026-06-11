import type { AnyEnvelope } from '@codepulse/protocol';
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
export type AiSessionInsert = Omit<AiSessionRow, 'created_at' | 'last_activity_at' | 'active_duration'>;
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
export declare class DatabaseV5 {
    private db;
    private readonly dbPath;
    private writeQueue;
    /**
     * Marks async call chains already executing inside a queued write —
     * AsyncLocalStorage (not a boolean flag) because the marker must follow
     * the async chain across awaits, where interleaved outside callers would
     * otherwise observe a stale flag and bypass the queue.
     */
    private readonly writeScope;
    constructor(dataDir: string, dbFileName?: string);
    get path(): string;
    open(): Promise<void>;
    close(): Promise<void>;
    getSchemaVersion(): Promise<number>;
    migrate(): Promise<void>;
    insertAiSession(session: AiSessionInsert): Promise<void>;
    /** Idempotent insert — ignores duplicate primary keys (scanner races / log replay). */
    insertAiSessionIfNotExists(session: AiSessionInsert): Promise<boolean>;
    getAiSession(id: string): Promise<AiSessionRow | null>;
    /**
     * Lists AI sessions newest first. `limit` is clamped (default 50, max
     * 1000); rows include last_activity_at + active_duration so callers can
     * derive activeDurationMs / lastActivityAt / isActive.
     */
    listAiSessions(limit?: number, offset?: number): Promise<AiSessionRow[]>;
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
    listAiActivityByDay(opts?: ListAiActivityOptions): Promise<AiActivityByDayRow[]>;
    /**
     * Closes open AI sessions whose last observed activity (falling back to
     * started_at) is older than the cutoff, setting ended_at to that
     * last-activity time. Returns the number of sessions closed.
     */
    endStaleAiSessions(olderThanMinutes: number): Promise<number>;
    /**
     * Lists coding sessions (persisted by ingestEnvelopeFromSpool) that
     * started within the last `days` days, newest first. Both params are
     * clamped to sane bounds — negatives and zero floor to 1, oversized
     * values cap at 90 days / 1000 rows.
     */
    listSessions(options?: ListSessionsOptions): Promise<SessionRow[]>;
    insertAiTokenUsage(usage: Omit<AiTokenUsageRow, 'id'>): Promise<number>;
    /**
     * Idempotent variant for envelope ingest — INSERT OR IGNORE against the
     * unique envelope_id index. Returns false when the envelope was already
     * recorded (replayed log line / spool re-read).
     */
    private insertAiTokenUsageIfNew;
    listAiTokenUsage(aiSessionId: string): Promise<AiTokenUsageRow[]>;
    insertFileSnapshot(snapshot: Omit<FileSnapshotRow, 'created_at'>): Promise<void>;
    getFileSnapshot(id: string): Promise<FileSnapshotRow | null>;
    listFileSnapshots(filter?: ListSnapshotsFilter): Promise<FileSnapshotRow[]>;
    upsertRegistryScanner(scanner: RegistryScannerRow): Promise<void>;
    touchRegistryScannerLastScan(scannerId: string, lastScanAt: string): Promise<void>;
    listRegistryScanners(): Promise<RegistryScannerRow[]>;
    endAiSession(id: string, endedAt: string): Promise<boolean>;
    upsertParserCursor(cursor: ParserCursorRow): Promise<void>;
    getParserCursor(scannerId: string, logGlob: string): Promise<ParserCursorRow | null>;
    insertPrivacyAudit(entry: Omit<PrivacyAuditRow, 'id'>): Promise<number>;
    listPrivacyAudit(limit?: number, offset?: number): Promise<PrivacyAuditRow[]>;
    aggregateTokenUsageByDay(day: string): Promise<TokenUsageAggregate[]>;
    /**
     * Ingests one envelope inside its own transaction so an envelope's
     * effects (e.g. token row) and its dedup marker can never be split by a
     * crash. Returns false for replays — dedup runs against the unique
     * envelope_id indexes instead of a json_extract full-table scan.
     */
    ingestEnvelopeFromSpool(envelope: AnyEnvelope): Promise<boolean>;
    /**
     * Atomically ingests a parsed-log batch and persists its parser cursor in
     * ONE transaction — a crash mid-batch can never advance the cursor past
     * unrecorded events or record events the cursor will replay. Returns the
     * envelopes that were newly ingested (replays are filtered out).
     */
    ingestLogBatchWithCursor(envelopes: AnyEnvelope[], cursor: ParserCursorRow): Promise<AnyEnvelope[]>;
    private ingestEnvelopeInTransaction;
    private ingestSessionStartedEnvelope;
    private ingestSessionEndedEnvelope;
    /**
     * Persists forwarded coding sessions — keyed on the session's own id (NOT
     * the envelope id), so repeated session.updated envelopes converge on one
     * row instead of being dropped while the spool grows.
     */
    private ingestCodingSessionEnvelope;
    private ingestToolDetectedEnvelope;
    private ingestTokensEnvelope;
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
    private accumulateAiActivity;
    private resolveAiSessionIdForUsage;
    /**
     * Clamps a backdated session start to the latest ended_at recorded for
     * the same (scanner, tool), so a freshly opened session can never overlap
     * a previously closed one (overlap would double-count run time). Starts
     * at or after the last end — and starts with no closed predecessor — pass
     * through unchanged.
     */
    private clampStartToLastEnded;
    private findActiveAiSession;
    /**
     * INSERT OR IGNORE against the unique envelope_id index — returns false
     * when this envelope's event was already recorded (replay).
     */
    private insertAiToolEvent;
    private migrateToV1;
    private migrateToV2;
    private migrateToV3;
    private migrateToV4;
    private migrateToV5;
    private migrateToV6;
    private migrateToV7;
    private migrateToV8;
    private setSchemaVersion;
    private addColumnIfMissing;
    private getDb;
    /**
     * Runs `fn` inside a BEGIN IMMEDIATE … COMMIT transaction, serialized
     * through the shared write queue with every other write entry point —
     * interleaved BEGINs on the same handle would otherwise fail with
     * "cannot start a transaction within a transaction", and a stray write
     * between BEGIN and COMMIT would silently join the open transaction.
     */
    private withTransaction;
    /**
     * Serializes one TOP-LEVEL write through the shared queue. All writers
     * share a single connection, so a statement issued between another
     * caller's BEGIN IMMEDIATE and COMMIT would silently join that open
     * transaction and die with its rollback. Statements already running
     * inside a queued write (an open transaction's own internals) execute
     * directly — re-queueing them would deadlock the chain on itself.
     */
    private enqueueWrite;
    /**
     * Write-path statement helper — funnels through the write queue so no
     * mutation can interleave into an open transaction. Reads (`get`/`all`)
     * stay unqueued.
     */
    private run;
    private runStatement;
    private get;
    private all;
}
//# sourceMappingURL=DatabaseV5.d.ts.map