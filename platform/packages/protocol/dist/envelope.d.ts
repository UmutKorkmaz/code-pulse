/** Current envelope wire format version. Bump on breaking envelope changes. */
export declare const ENVELOPE_VERSION: 1;
/** Maximum accepted frame size at the daemon ingest boundary (256 KiB). */
export declare const MAX_FRAME_BYTES: number;
/** Protocol version string referenced by scanner manifests (`minProtocol`). */
export declare const PROTOCOL_VERSION = "5.1";
export type EnvelopeVersion = typeof ENVELOPE_VERSION;
export type EnvelopeSource = 'daemon' | 'vscode' | 'desktop' | 'cli' | 'scanner';
export type EvidenceType = 'process' | 'log_line' | 'hook_event' | 'extension_report' | 'terminal';
/** Typed observation supporting confidence scoring; never carries raw content. */
export interface Evidence {
    type: EvidenceType;
    /** ISO-8601 timestamp of the observation. */
    timestamp: string;
    /** Content hash for deduplication — not the content itself. */
    hash: string;
}
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens: number;
    model?: string;
    currency?: string;
    estimatedCost?: number;
    /** `true` when derived from heuristics; `false` when sourced from tool telemetry. */
    isEstimated: boolean;
    /** Optional linkage when usage is attributed to a specific AI session. */
    aiSessionId?: string;
    /** Scanner that produced this usage record. */
    scannerId?: string;
    /** Human-readable tool name (e.g. `claude-code`, `codex`). */
    tool?: string;
}
export type FileChangeType = 'create' | 'modify' | 'delete';
export interface FileChangeMeta {
    /** HMAC(path, per_install_salt) — cleartext paths are not stored. */
    pathHash: string;
    repoRootHash?: string;
    changeType: FileChangeType;
    linesAdded: number;
    linesRemoved: number;
    language?: string;
    /** Captured at hook time — highest-value attribution signal. */
    aiAttributed: boolean;
    aiSessionId?: string;
}
export type SnapshotType = 'pre_ai' | 'checkpoint' | 'post_ai' | 'manual';
export interface FileSnapshotMeta {
    id: string;
    aiSessionId?: string;
    sessionId?: string;
    project: string;
    pathHash: string;
    snapshotType: SnapshotType;
    diffPath?: string;
    fileHashBefore?: string;
    fileHashAfter?: string;
    sizeBytes?: number;
    /** ISO-8601 creation timestamp. */
    createdAt: string;
}
export type AISessionSource = 'process' | 'log' | 'hook' | 'extension' | 'terminal' | 'lm';
export interface AISession {
    id: string;
    /** Linked coding session, when the AI work occurred inside one. */
    sessionId?: string;
    scannerId: string;
    tool: string;
    model?: string;
    startedAt: string;
    endedAt?: string;
    confidence: number;
    source?: AISessionSource;
    /** ISO-8601 timestamp of the most recent activity event attached to this session. */
    lastActivityAt?: string;
    /** Gap-windowed active work time in SECONDS (same unit as CodingSession.duration). */
    activeDuration?: number;
    /** Wall-clock run time in seconds while the tool's process is alive. */
    runDuration?: number;
}
/** JSON-serializable coding session snapshot for wire transport. */
export interface CodingSession {
    id: string;
    startTime: string;
    endTime?: string;
    /** Active coding duration in seconds. */
    duration: number;
    idleDuration: number;
    project: string;
    language: string;
    file: string;
    branch?: string;
    isActive: boolean;
    heartbeats: number;
    keystrokes: number;
    linesAdded: number;
    linesRemoved: number;
    productivityScore?: number;
    tags?: string[];
    aiAssisted?: boolean;
}
export type RecoveryActionKind = 'restore.dry_run' | 'restore.confirmed' | 'restore.completed' | 'restore.failed' | 'snapshot.created';
export interface RecoveryAction {
    id: string;
    aiSessionId?: string;
    snapshotId: string;
    action: RecoveryActionKind;
    correlationId: string;
    filesAffected: number;
    occurredAt: string;
    dryRun?: boolean;
    error?: string;
}
export type ClientKind = 'vscode' | 'desktop' | 'cli';
export interface ClientInfo {
    id: string;
    kind: ClientKind;
    version?: string;
    connectedAt: string;
}
export type TrustTier = 'official' | 'verified' | 'community';
export interface ScannerManifestSummary {
    id: string;
    version: string;
    displayName: string;
    trust: TrustTier;
    enabled: boolean;
    lastScanAt?: string;
    evidenceCount?: number;
}
export type DaemonEventType = DaemonEvent['type'];
export type DaemonEvent = {
    type: 'session.started';
    session: CodingSession;
} | {
    type: 'session.updated';
    session: CodingSession;
} | {
    type: 'session.ended';
    session: CodingSession;
} | {
    type: 'ai.tool.detected';
    tool: string;
    confidence: number;
    evidence: Evidence[];
    scannerId?: string;
} | {
    type: 'ai.session.started';
    aiSession: AISession;
} | {
    type: 'ai.session.updated';
    aiSession: AISession;
} | {
    type: 'ai.session.ended';
    aiSession: AISession;
} | {
    type: 'ai.tokens';
    usage: TokenUsage;
} | {
    type: 'file.snapshot';
    snapshot: FileSnapshotMeta;
} | {
    type: 'file.change';
    change: FileChangeMeta;
} | {
    type: 'recovery.action';
    action: RecoveryAction;
} | {
    type: 'registry.updated';
    scanners: ScannerManifestSummary[];
} | {
    type: 'scanner.quarantined';
    scannerId: string;
    reason: string;
    version?: string;
    errorRate?: number;
    threshold?: number;
    eventsDropped?: number;
} | {
    type: 'client.connected';
    client: ClientInfo;
};
/**
 * Versioned wrapper for WebSocket messages and NDJSON spool lines.
 * `type` mirrors `payload.type` for fast routing without unpacking.
 */
export interface Envelope<T extends DaemonEvent = DaemonEvent> {
    v: EnvelopeVersion;
    /** ULID — idempotent ingest key. */
    id: string;
    /** Milliseconds since Unix epoch. */
    ts: number;
    src: EnvelopeSource;
    /** Correlates request ↔ response pairs across clients. */
    corr?: string;
    type: T['type'];
    payload: T;
}
/** Convenience alias for envelopes whose payload type is not narrowed. */
export type AnyEnvelope = Envelope<DaemonEvent>;
//# sourceMappingURL=envelope.d.ts.map