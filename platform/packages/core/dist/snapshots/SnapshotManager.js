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
exports.SnapshotManager = exports.UntrustedProjectRootError = void 0;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DatabaseV5_1 = require("../db/DatabaseV5");
const paths_1 = require("../paths");
const path_guard_1 = require("./path-guard");
/**
 * Thrown when a caller-supplied projectRoot fails the trust checks. The daemon
 * maps this to an HTTP 400 so the reason is surfaced to the client.
 */
class UntrustedProjectRootError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UntrustedProjectRootError';
    }
}
exports.UntrustedProjectRootError = UntrustedProjectRootError;
class SnapshotManager {
    dataDir;
    snapshotsDir;
    database;
    recoveryTokenPath;
    recoveryTokens = new Map();
    recoveryTokenTtlMs = 60_000;
    constructor(options = {}) {
        this.dataDir = options.dataDir ?? (0, paths_1.defaultDataDir)();
        this.snapshotsDir = options.snapshotsDir ?? path.join(this.dataDir, 'snapshots');
        this.database = options.database ?? new DatabaseV5_1.DatabaseV5(this.dataDir);
        this.recoveryTokenPath = path.join(this.dataDir, 'recovery-tokens.json');
        this.loadRecoveryTokens();
    }
    get db() {
        return this.database;
    }
    async initialize() {
        (0, paths_1.ensureDir)(this.snapshotsDir);
        await this.database.open();
    }
    async close() {
        await this.database.close();
    }
    async createPreAiSnapshot(input) {
        const snapshotId = crypto.randomUUID();
        // Fail closed on an untrusted root before resolving the file path.
        const realRoot = this.assertTrustedRoot(input.projectRoot);
        const resolvedPath = (0, path_guard_1.resolvePathWithinProject)(realRoot, input.filePath);
        const relativePath = path.relative(realRoot, resolvedPath);
        const before = input.contentBefore ?? (await this.readFileIfExists(resolvedPath)) ?? '';
        const fileHashBefore = this.hashContent(before);
        const diffPath = path.join(this.snapshotsDir, `${snapshotId}.diff`);
        const blob = {
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
        const row = {
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
    async listSnapshots(filter = {}) {
        return this.database.listFileSnapshots(filter);
    }
    async getSnapshot(id) {
        return this.database.getFileSnapshot(id);
    }
    async restoreSnapshot(snapshotId, options = {}) {
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
            throw new Error(`Snapshot ${snapshotId} predates project-root validation and cannot be restored safely`);
        }
        const realRoot = this.assertTrustedRoot(blob.projectRoot);
        const verifiedPath = (0, path_guard_1.resolvePathWithinProject)(realRoot, blob.relativePath);
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
        let backupPath;
        if (currentContent !== null && wouldWrite) {
            backupPath = `${blob.filePath}.pre-restore`;
            await fs.promises.writeFile(backupPath, currentContent, 'utf8');
        }
        if (wouldWrite) {
            (0, paths_1.ensureDir)(path.dirname(blob.filePath));
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
    assertTrustedRoot(projectRoot) {
        try {
            return (0, path_guard_1.assertTrustedProjectRoot)(projectRoot);
        }
        catch (error) {
            throw new UntrustedProjectRootError(error instanceof Error ? error.message : 'Untrusted project root');
        }
    }
    async readDiffBlob(diffPath) {
        const raw = await fs.promises.readFile(diffPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1) {
            throw new Error(`Unsupported diff blob version: ${String(parsed.version)}`);
        }
        return parsed;
    }
    async readFileIfExists(filePath) {
        try {
            return await fs.promises.readFile(filePath, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }
    hashContent(content) {
        return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    }
    buildUnifiedDiff(filePath, current, restored) {
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
    consumeRecoveryToken(token, snapshotId) {
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
    loadRecoveryTokens() {
        try {
            const raw = fs.readFileSync(this.recoveryTokenPath, 'utf8');
            const parsed = JSON.parse(raw);
            const now = Date.now();
            for (const [token, entry] of Object.entries(parsed)) {
                if (entry.expiresAt >= now) {
                    this.recoveryTokens.set(token, entry);
                }
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }
    persistRecoveryTokens() {
        const now = Date.now();
        const payload = {};
        for (const [token, entry] of this.recoveryTokens.entries()) {
            if (entry.expiresAt >= now) {
                payload[token] = entry;
            }
        }
        (0, paths_1.ensureDir)(this.dataDir);
        fs.writeFileSync(this.recoveryTokenPath, JSON.stringify(payload, null, 2), 'utf8');
    }
}
exports.SnapshotManager = SnapshotManager;
//# sourceMappingURL=SnapshotManager.js.map