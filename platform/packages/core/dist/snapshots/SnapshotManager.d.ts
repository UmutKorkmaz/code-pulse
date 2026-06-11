import type { SnapshotType } from '@codepulse/protocol';
import { DatabaseV5, type FileSnapshotRow } from '../db/DatabaseV5';
/**
 * Thrown when a caller-supplied projectRoot fails the trust checks. The daemon
 * maps this to an HTTP 400 so the reason is surfaced to the client.
 */
export declare class UntrustedProjectRootError extends Error {
    constructor(message: string);
}
export interface SnapshotDiffBlob {
    version: 1;
    snapshotId: string;
    filePath: string;
    /** Canonical project root the relative path is resolved against at restore. */
    projectRoot?: string;
    /** File path relative to projectRoot; re-validated before any write. */
    relativePath?: string;
    project: string;
    snapshotType: SnapshotType;
    before: string;
    after?: string | null;
    createdAt: string;
}
export interface CreatePreAiSnapshotInput {
    project: string;
    projectRoot: string;
    filePath: string;
    aiSessionId?: string;
    sessionId?: string;
    contentBefore?: string;
}
export interface RestoreSnapshotOptions {
    dryRun?: boolean;
    recoveryToken?: string;
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
export interface SnapshotManagerOptions {
    dataDir?: string;
    snapshotsDir?: string;
    database?: DatabaseV5;
}
export declare class SnapshotManager {
    private readonly dataDir;
    private readonly snapshotsDir;
    private readonly database;
    private readonly recoveryTokenPath;
    private readonly recoveryTokens;
    private readonly recoveryTokenTtlMs;
    constructor(options?: SnapshotManagerOptions);
    get db(): DatabaseV5;
    initialize(): Promise<void>;
    close(): Promise<void>;
    createPreAiSnapshot(input: CreatePreAiSnapshotInput): Promise<FileSnapshotRow>;
    listSnapshots(filter?: {
        aiSessionId?: string;
        sessionId?: string;
        project?: string;
        snapshotType?: SnapshotType;
        limit?: number;
        offset?: number;
    }): Promise<FileSnapshotRow[]>;
    getSnapshot(id: string): Promise<FileSnapshotRow | null>;
    restoreSnapshot(snapshotId: string, options?: RestoreSnapshotOptions): Promise<RestoreSnapshotResult>;
    /** Wraps the trust check so failures surface as UntrustedProjectRootError. */
    private assertTrustedRoot;
    private readDiffBlob;
    private readFileIfExists;
    private hashContent;
    private buildUnifiedDiff;
    private consumeRecoveryToken;
    private loadRecoveryTokens;
    private persistRecoveryTokens;
}
//# sourceMappingURL=SnapshotManager.d.ts.map