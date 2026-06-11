import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import {
    DatabaseV5,
    SnapshotManager,
    UntrustedProjectRootError,
    type SnapshotDiffBlob
} from '@codepulse/core';

const ORIGINAL_CONTENT = 'const answer = 42;\nexport { answer };\n';
const MUTATED_CONTENT = 'const answer = 0; // clobbered by AI\n';

describe('SnapshotManager', () => {
    let tempDir = '';
    let dataDir = '';
    let projectRoot = '';
    let trackedFile = '';
    let manager: SnapshotManager;

    beforeEach(async () => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-snap-'));
        dataDir = nodePath.join(tempDir, 'data');
        projectRoot = nodePath.join(tempDir, 'project');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(nodePath.join(projectRoot, '.git'), { recursive: true });
        fs.mkdirSync(nodePath.join(projectRoot, 'src'));
        trackedFile = nodePath.join(projectRoot, 'src', 'app.ts');
        fs.writeFileSync(trackedFile, ORIGINAL_CONTENT, 'utf8');

        manager = new SnapshotManager({ dataDir, database: new DatabaseV5(dataDir) });
        await manager.initialize();
    });

    afterEach(async () => {
        await manager.close();
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('restores the exact pre-AI content through a create -> mutate -> restore round-trip', async () => {
        // Arrange
        const snapshot = await manager.createPreAiSnapshot({
            project: 'code-pulse',
            projectRoot,
            filePath: 'src/app.ts'
        });
        fs.writeFileSync(trackedFile, MUTATED_CONTENT, 'utf8');

        // Act: dry run first to obtain a recovery token, then confirm.
        const dryRun = await manager.restoreSnapshot(snapshot.id);
        assert.strictEqual(dryRun.dryRun, true);
        assert.strictEqual(dryRun.wouldWrite, true);
        assert.strictEqual(dryRun.restored, false);
        assert.ok(dryRun.recoveryToken);
        assert.strictEqual(fs.readFileSync(trackedFile, 'utf8'), MUTATED_CONTENT);

        const confirmed = await manager.restoreSnapshot(snapshot.id, {
            dryRun: false,
            recoveryToken: dryRun.recoveryToken
        });

        // Assert
        assert.strictEqual(confirmed.restored, true);
        assert.strictEqual(fs.readFileSync(trackedFile, 'utf8'), ORIGINAL_CONTENT);
        assert.ok(confirmed.backupPath);
        assert.strictEqual(fs.readFileSync(confirmed.backupPath, 'utf8'), MUTATED_CONTENT);
    });

    it('rejects creating a snapshot for an untrusted project root', async () => {
        const bareRoot = nodePath.join(tempDir, 'untrusted');
        fs.mkdirSync(bareRoot);

        await assert.rejects(
            manager.createPreAiSnapshot({
                project: 'code-pulse',
                projectRoot: bareRoot,
                filePath: 'src/app.ts'
            }),
            UntrustedProjectRootError
        );
    });

    it('rejects creating a snapshot whose file path escapes the project root', async () => {
        await assert.rejects(
            manager.createPreAiSnapshot({
                project: 'code-pulse',
                projectRoot,
                filePath: '../escape.ts'
            }),
            /escapes project root/
        );
    });

    it('rejects restoring a blob whose projectRoot fails validation', async () => {
        // Arrange: tamper the persisted diff blob to point at an untrusted root.
        const snapshot = await manager.createPreAiSnapshot({
            project: 'code-pulse',
            projectRoot,
            filePath: 'src/app.ts'
        });
        assert.ok(snapshot.diff_path);
        const untrustedRoot = nodePath.join(tempDir, 'untrusted');
        fs.mkdirSync(untrustedRoot);
        const blob = JSON.parse(fs.readFileSync(snapshot.diff_path, 'utf8')) as SnapshotDiffBlob;
        const tampered: SnapshotDiffBlob = { ...blob, projectRoot: untrustedRoot };
        fs.writeFileSync(snapshot.diff_path, JSON.stringify(tampered, null, 2), 'utf8');

        // Act + Assert: the trust check fails closed before any write.
        await assert.rejects(manager.restoreSnapshot(snapshot.id), UntrustedProjectRootError);
        assert.strictEqual(fs.readFileSync(trackedFile, 'utf8'), ORIGINAL_CONTENT);
    });

    it('rejects a confirmed restore without a valid recovery token', async () => {
        const snapshot = await manager.createPreAiSnapshot({
            project: 'code-pulse',
            projectRoot,
            filePath: 'src/app.ts'
        });
        fs.writeFileSync(trackedFile, MUTATED_CONTENT, 'utf8');

        await assert.rejects(
            manager.restoreSnapshot(snapshot.id, { dryRun: false, recoveryToken: 'bogus' }),
            /Valid recovery token required/
        );
        assert.strictEqual(fs.readFileSync(trackedFile, 'utf8'), MUTATED_CONTENT);
    });
});
