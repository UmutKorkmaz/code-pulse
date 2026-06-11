export interface DaemonResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
    timestamp: string;
}

export interface DaemonStatus {
    service?: string;
    version?: string;
    status?: string;
    uptime?: number;
    connectedClients?: number;
    isTracking?: boolean;
}

export interface DaemonHealth {
    status?: string;
    tracking?: boolean;
    database?: string;
    uptime?: number;
    version?: string;
}

export interface RegistryScanner {
    id: string;
    version?: string;
    displayName?: string;
    publisher?: string;
    trust?: string;
    enabled?: boolean;
    lastScanAt?: string;
}

export interface RegistryList {
    scanners?: RegistryScanner[];
    updatedAt?: string;
}

export interface TokenAggregate {
    tool?: string;
    model?: string;
    day?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
}

export interface AiSession {
    id?: string;
    tool?: string;
    model?: string;
    startedAt?: string;
    endedAt?: string;
    /** Wall-clock run time in milliseconds (open sessions count up to now). */
    durationMs?: number;
    /** Gap-windowed active work time in milliseconds. */
    activeDurationMs?: number;
    /** ISO timestamp of the most recent activity event. */
    lastActivityAt?: string;
    /** True while the session has no ended_at. */
    isActive?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    project?: string;
}

export interface AiSessionsResponse {
    sessions?: AiSession[];
    total?: number;
}

/**
 * One local-day × tool aggregate of AI run/active work time and token usage
 * from GET /v1/ai/activity. ALL time fields are milliseconds.
 */
export interface AiActivityRow {
    /** Local calendar day (YYYY-MM-DD). */
    day?: string;
    tool?: string;
    /** Wall-clock run time in milliseconds (open sessions count up to now). */
    runMs?: number;
    /** Gap-windowed active work time in milliseconds. */
    activeMs?: number;
    sessions?: number;
    inputTokens?: number;
    outputTokens?: number;
}

export interface AiActivityResponse {
    activity?: AiActivityRow[];
    total?: number;
}

export interface CodingSessionSummary {
    id?: string;
    startTime?: string;
    endTime?: string;
    /** Active coding duration in seconds. */
    duration?: number;
    idleDuration?: number;
    project?: string;
    language?: string;
    file?: string;
    branch?: string;
    isActive?: boolean;
    heartbeats?: number;
    keystrokes?: number;
    linesAdded?: number;
    linesRemoved?: number;
    productivityScore?: number;
    tags?: string[];
}

export interface SessionsResponse {
    sessions?: CodingSessionSummary[];
    total?: number;
}

export interface PingResult {
    ok: boolean;
    latencyMs: number;
    health?: DaemonHealth;
    error?: string;
}

export interface FileSnapshot {
    id: string;
    ai_session_id?: string | null;
    session_id?: string | null;
    project: string;
    file_path: string;
    snapshot_type: string;
    diff_path?: string | null;
    file_hash_before?: string | null;
    file_hash_after?: string | null;
    size_bytes?: number | null;
    created_at: string;
}

export interface SnapshotListResponse {
    snapshots: FileSnapshot[];
}

export interface RestoreSnapshotResult {
    snapshotId: string;
    filePath: string;
    project: string;
    dryRun: boolean;
    wouldWrite: boolean;
    currentHash: string | null;
    restoredHash: string;
    diffPreview: string;
    backupPath?: string;
    recoveryToken?: string;
    restored: boolean;
}

export interface DaemonClientOptions {
    host?: string;
    port?: number;
    token?: string;
    timeoutMs?: number;
}