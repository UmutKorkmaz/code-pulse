import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Validates that a project root is safe to read from / write into.
 *
 * Fails closed (throws) unless the root is an absolute, existing directory that
 * is NOT the user home dir, the filesystem root, or a parent of home, and that
 * either contains a `.git` directory or is explicitly listed in the
 * colon-separated `CODEPULSE_ALLOWED_ROOTS` env var.
 *
 * Returns the canonical (realpath-resolved) absolute root.
 */
export function assertTrustedProjectRoot(projectRoot: string): string {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
        throw new Error('projectRoot is required');
    }
    if (!path.isAbsolute(projectRoot)) {
        throw new Error(`projectRoot must be an absolute path: ${projectRoot}`);
    }

    let realRoot: string;
    try {
        const stat = fs.statSync(projectRoot);
        if (!stat.isDirectory()) {
            throw new Error(`projectRoot is not a directory: ${projectRoot}`);
        }
        realRoot = fs.realpathSync.native(projectRoot);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`projectRoot does not exist: ${projectRoot}`);
        }
        throw error;
    }

    const home = fs.realpathSync.native(os.homedir());
    const fsRoot = path.parse(realRoot).root;

    if (realRoot === fsRoot) {
        throw new Error(`projectRoot must not be the filesystem root: ${projectRoot}`);
    }
    if (realRoot === home) {
        throw new Error(`projectRoot must not be the user home directory: ${projectRoot}`);
    }
    // Reject any ancestor of the home directory (e.g. /Users, /home).
    if (home === realRoot || home.startsWith(realRoot + path.sep)) {
        throw new Error(`projectRoot must not be a parent of the user home directory: ${projectRoot}`);
    }

    const allowed = parseAllowedRoots(process.env.CODEPULSE_ALLOWED_ROOTS);
    const isAllowlisted = allowed.some(entry => entry === realRoot);
    const hasGit = isGitRepoRoot(realRoot);

    if (!hasGit && !isAllowlisted) {
        throw new Error(
            `projectRoot must contain a .git directory or be listed in CODEPULSE_ALLOWED_ROOTS: ${projectRoot}`
        );
    }

    return realRoot;
}

function parseAllowedRoots(value: string | undefined): string[] {
    if (!value) {
        return [];
    }
    return value
        .split(':')
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0 && path.isAbsolute(entry))
        .map(entry => {
            try {
                return fs.realpathSync.native(entry);
            } catch {
                return path.resolve(entry);
            }
        });
}

function isGitRepoRoot(root: string): boolean {
    try {
        return fs.existsSync(path.join(root, '.git'));
    } catch {
        return false;
    }
}

export function resolvePathWithinProject(
    projectRoot: string,
    filePath: string
): string {
    const root = path.resolve(projectRoot);
    const resolved = path.resolve(root, filePath.startsWith(root) ? path.relative(root, filePath) : filePath);

    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        throw new Error(`Path escapes project root: ${filePath}`);
    }

    const realRoot = fs.realpathSync.native(root);
    let realResolved: string;
    try {
        realResolved = fs.realpathSync.native(resolved);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            const parent = path.dirname(resolved);
            const realParent = fs.realpathSync.native(parent);
            realResolved = path.join(realParent, path.basename(resolved));
        } else {
            throw error;
        }
    }

    if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
        throw new Error(`Path escapes project root via symlink: ${filePath}`);
    }

    return resolved;
}