import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { SnapshotType } from '@codepulse/protocol';
import { DatabaseV5, type FileSnapshotRow } from '../db/DatabaseV5';
import { defaultDataDir, ensureDir } from '../paths';
import { assertTrustedProjectRoot, resolvePathWithinProject } from './path-guard';

/**
 * Thrown when a caller-supplied projectRoot fails the trust checks. The daemon
 * maps this to an HTTP 400 so the reason is surfaced to the client.
 */
export class UntrustedProjectRootError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UntrustedProjectRootError';
    }
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

interface PersistedRecoveryToken {
    snapshotId: string;
    expiresAt: number;
}

export class SnapshotManager {
    private readonly dataDir: string;
    private readonly snapshotsDir: string;
    private readonly database: DatabaseV5;
    private readonly recoveryTokenPath: string;
    private readonly recoveryTokens = new Map<string, PersistedRecoveryToken>();
    private readonly recoveryTokenTtlMs = 60_000;

    constructor(options: SnapshotManagerOptions = {}) {
        this.dataDir = options.dataDir ?? defaultDataDir();
        this.snapshotsDir = options.snapshotsDir ?? path.join(this.dataDir, 'snapshots');
        this.database = options.database ?? new DatabaseV5(this.dataDir);
        this.recoveryTokenPath = path.join(this.dataDir, 'recovery-tokens.json');
        this.loadRecoveryTokens();
    }

    get db(): DatabaseV5 {
        return this.database;
    }

    async initialize(): Promise<void> {
        ensureDir(this.snapshotsDir);
        await this.database.open();
    }

    async close(): Promise<void> {
        await this.database.close();
    }

    async createPreAiSnapshot(input: CreatePreAiSnapshotInput): Promise<FileSnapshotRow> {
        const snapshotId = crypto.randomUUID();
        // Fail closed on an untrusted root before resolving the file path.
        const realRoot = this.assertTrustedRoot(input.projectRoot);
        const resolvedPath = resolvePathWithinProject(realRoot, input.filePath);
        const relativePath = path.relative(realRoot, resolvedPath);
        const before = input.contentBefore ?? (await this.readFileIfExists(resolvedPath)) ?? '';
        const fileHashBefore = this.hashContent(before);
        const diffPath = path.join(this.snapshotsDir, `${snapshotId}.diff`);

        const blob: SnapshotDiffBlob = {
            version: 1,
            snapshotId,
            filePath: resolvedPath,
            projectRoot: realRoot,
            relativePath,
            project: input.project,
            snapshotType: 'pre_ai',
            before,
            after: null,
            createdAt: new Date().toISOString()
        };

        await fs.promises.writeFile(diffPath, JSON.stringify(blob, null, 2), 'utf8');

        const row: Omit<FileSnapshotRow, 'created_at'> = {
            id: snapshotId,
            ai_session_id: input.aiSessionId ?? null,
            session_id: input.sessionId ?? null,
            project: input.project,
            file_path: resolvedPath,
            snapshot_type: 'pre_ai',
            diff_path: diffPath,
            file_hash_before: fileHashBefore,
            file_hash_after: null,
            size_bytes: Buffer.byteLength(before, 'utf8')
        };

        await this.database.insertFileSnapshot(row);
        const created = await this.database.getFileSnapshot(snapshotId);
        if (!created) {
            throw new Error(`Failed to persist snapshot ${snapshotId}`);
        }
        return created;
    }

    async listSnapshots(filter: {
        aiSessionId?: string;
        sessionId?: string;
        project?: string;
        snapshotType?: SnapshotType;
        limit?: number;
        offset?: number;
    } = {}): Promise<FileSnapshotRow[]> {
        return this.database.listFileSnapshots(filter);
    }

    async getSnapshot(id: string): Promise<FileSnapshotRow | null> {
        return this.database.getFileSnapshot(id);
    }

    async restoreSnapshot(
        snapshotId: string,
        options: RestoreSnapshotOptions = {}
    ): Promise<RestoreSnapshotResult> {
        const snapshot = await this.database.getFileSnapshot(snapshotId);
        if (!snapshot) {
            throw new Error(`Snapshot not found: ${snapshotId}`);
        }
        if (!snapshot.diff_path) {
            throw new Error(`Snapshot ${snapshotId} has no diff blob`);
        }

        const blob = await this.readDiffBlob(snapshot.diff_path);
        if (blob.snapshotId !== snapshotId || blob.filePath !== snapshot.file_path) {
            throw new Error(`Diff blob metadata mismatch for snapshot ${snapshotId}`);
        }

        // Re-derive the write target from the stored root + relative path and
        // require it to equal the originally validated absolute path. A tampered
        // DB/blob cannot redirect the write outside the trusted root.
        if (!blob.projectRoot || !blob.relativePath) {
            throw new Error(
                `Snapshot ${snapshotId} predates project-root validation and cannot be restored safely`
            );
        }
        const realRoot = this.assertTrustedRoot(blob.projectRoot);
        const verifiedPath = resolvePathWithinProject(realRoot, blob.relativePath);
        if (verifiedPath !== blob.filePath) {
            throw new Error(`Restore target path mismatch for snapshot ${snapshotId}`);
        }

        const currentContent = await this.readFileIfExists(blob.filePath);
        const currentHash = currentContent === null ? null : this.hashContent(currentContent);
        const restoredHash = this.hashContent(blob.before);
        const wouldWrite = currentContent !== blob.before;
        const diffPreview = this.buildUnifiedDiff(blob.filePath, currentContent ?? '', blob.before);
        const dryRun = options.dryRun !== false;

        if (dryRun) {
            const recoveryToken = crypto.randomUUID();
            this.recoveryTokens.set(recoveryToken, {
                snapshotId,
                expiresAt: Date.now() + this.recoveryTokenTtlMs
            });
            this.persistRecoveryTokens();

            return {
                snapshotId,
                filePath: blob.filePath,
                project: blob.project,
                dryRun: true,
                wouldWrite,
                currentHash,
                restoredHash,
                diffPreview,
                recoveryToken,
                restored: false
            };
        }

        if (!options.recoveryToken || !this.consumeRecoveryToken(options.recoveryToken, snapshotId)) {
            throw new Error('Valid recovery token required for confirmed restore');
        }

        let backupPath: string | undefined;
        if (currentContent !== null && wouldWrite) {
            backupPath = `${blob.filePath}.pre-restore`;
            await fs.promises.writeFile(backupPath, currentContent, 'utf8');
        }

        if (wouldWrite) {
            ensureDir(path.dirname(blob.filePath));
            await fs.promises.writeFile(blob.filePath, blob.before, 'utf8');
        }

        await this.database.insertPrivacyAudit({
            actor: 'snapshot-manager',
            operation: 'restore.confirmed',
            target_hash: this.hashContent(blob.filePath),
            occurred_at: new Date().toISOString()
        });

        return {
            snapshotId,
            filePath: blob.filePath,
            project: blob.project,
            dryRun: false,
            wouldWrite,
            currentHash,
            restoredHash,
            diffPreview,
            backupPath,
            restored: wouldWrite
        };
    }

    /** Wraps the trust check so failures surface as UntrustedProjectRootError. */
    private assertTrustedRoot(projectRoot: string): string {
        try {
            return assertTrustedProjectRoot(projectRoot);
        } catch (error) {
            throw new UntrustedProjectRootError(
                error instanceof Error ? error.message : 'Untrusted project root'
            );
        }
    }

    private async readDiffBlob(diffPath: string): Promise<SnapshotDiffBlob> {
        const raw = await fs.promises.readFile(diffPath, 'utf8');
        const parsed = JSON.parse(raw) as SnapshotDiffBlob;
        if (parsed.version !== 1) {
            throw new Error(`Unsupported diff blob version: ${String((parsed as { version?: unknown }).version)}`);
        }
        return parsed;
    }

    private async readFileIfExists(filePath: string): Promise<string | null> {
        try {
            return await fs.promises.readFile(filePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    private hashContent(content: string): string {
        return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    }

    private buildUnifiedDiff(filePath: string, current: string, restored: string): string {
        const currentLines = current.split('\n');
        const restoredLines = restored.split('\n');
        const header = [
            `--- a/${filePath}`,
            `+++ b/${filePath}`,
            `@@ -1,${currentLines.length} +1,${restoredLines.length} @@`
        ];

        const removed = currentLines.map(line => `-${line}`);
        const added = restoredLines.map(line => `+${line}`);
        return [...header, ...removed, ...added].join('\n');
    }

    private consumeRecoveryToken(token: string, snapshotId: string): boolean {
        const entry = this.recoveryTokens.get(token);
        this.recoveryTokens.delete(token);
        this.persistRecoveryTokens();
        if (!entry) {
            return false;
        }
        if (entry.snapshotId !== snapshotId) {
            return false;
        }
        return entry.expiresAt >= Date.now();
    }

    private loadRecoveryTokens(): void {
        try {
            const raw = fs.readFileSync(this.recoveryTokenPath, 'utf8');
            const parsed = JSON.parse(raw) as Record<string, PersistedRecoveryToken>;
            const now = Date.now();
            for (const [token, entry] of Object.entries(parsed)) {
                if (entry.expiresAt >= now) {
                    this.recoveryTokens.set(token, entry);
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }

    private persistRecoveryTokens(): void {
        const now = Date.now();
        const payload: Record<string, PersistedRecoveryToken> = {};
        for (const [token, entry] of this.recoveryTokens.entries()) {
            if (entry.expiresAt >= now) {
                payload[token] = entry;
            }
        }

        ensureDir(this.dataDir);
        fs.writeFileSync(this.recoveryTokenPath, JSON.stringify(payload, null, 2), 'utf8');
    }
}