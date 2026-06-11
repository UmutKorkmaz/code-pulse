import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

// Compiled core path guard — import via relative path to dist for tests
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTrustedProjectRoot, resolvePathWithinProject } = require(
    '../../../packages/core/dist/snapshots/path-guard.js'
) as {
    assertTrustedProjectRoot: (projectRoot: string) => string;
    resolvePathWithinProject: (projectRoot: string, filePath: string) => string;
};

describe('snapshot path guard', () => {
    let tempDir = '';
    let projectRoot = '';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-guard-'));
        projectRoot = nodePath.join(tempDir, 'project');
        fs.mkdirSync(nodePath.join(projectRoot, '.git'), { recursive: true });
    });

    afterEach(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects relative traversal out of the project root', () => {
        assert.throws(
            () => resolvePathWithinProject(projectRoot, '../escape'),
            /escapes project root/
        );
    });

    it('rejects an absolute path outside the project root', () => {
        assert.throws(
            () => resolvePathWithinProject(projectRoot, '/etc/passwd'),
            /escapes project root/
        );
    });

    it('rejects a symlinked directory that escapes the project root', () => {
        // Arrange: project/link -> sibling dir outside the root.
        const outside = nodePath.join(tempDir, 'outside');
        fs.mkdirSync(outside);
        fs.writeFileSync(nodePath.join(outside, 'secret.txt'), 'secret');
        fs.symlinkSync(outside, nodePath.join(projectRoot, 'link'));

        // Act + Assert
        assert.throws(
            () => resolvePathWithinProject(projectRoot, 'link/secret.txt'),
            /escapes project root via symlink/
        );
    });

    it('resolves a normal relative path inside the project root', () => {
        fs.mkdirSync(nodePath.join(projectRoot, 'src'));
        fs.writeFileSync(nodePath.join(projectRoot, 'src', 'app.ts'), 'export {};');

        const resolved = resolvePathWithinProject(projectRoot, 'src/app.ts');

        assert.strictEqual(resolved, nodePath.join(projectRoot, 'src', 'app.ts'));
    });

    it('accepts a git project root and returns its canonical path', () => {
        const realRoot = assertTrustedProjectRoot(projectRoot);

        assert.strictEqual(realRoot, fs.realpathSync.native(projectRoot));
    });

    it('rejects a project root without .git that is not allowlisted', () => {
        const bareDir = nodePath.join(tempDir, 'bare');
        fs.mkdirSync(bareDir);

        assert.throws(
            () => assertTrustedProjectRoot(bareDir),
            /must contain a \.git directory or be listed in CODEPULSE_ALLOWED_ROOTS/
        );
    });

    it('rejects relative, missing, and home project roots', () => {
        assert.throws(() => assertTrustedProjectRoot('relative/path'), /must be an absolute path/);
        assert.throws(
            () => assertTrustedProjectRoot(nodePath.join(tempDir, 'missing')),
            /does not exist/
        );
        assert.throws(
            () => assertTrustedProjectRoot(os.homedir()),
            /must not be the user home directory/
        );
    });
});
