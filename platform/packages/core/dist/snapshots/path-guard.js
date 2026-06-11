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
exports.assertTrustedProjectRoot = assertTrustedProjectRoot;
exports.resolvePathWithinProject = resolvePathWithinProject;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
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
function assertTrustedProjectRoot(projectRoot) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
        throw new Error('projectRoot is required');
    }
    if (!path.isAbsolute(projectRoot)) {
        throw new Error(`projectRoot must be an absolute path: ${projectRoot}`);
    }
    let realRoot;
    try {
        const stat = fs.statSync(projectRoot);
        if (!stat.isDirectory()) {
            throw new Error(`projectRoot is not a directory: ${projectRoot}`);
        }
        realRoot = fs.realpathSync.native(projectRoot);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
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
        throw new Error(`projectRoot must contain a .git directory or be listed in CODEPULSE_ALLOWED_ROOTS: ${projectRoot}`);
    }
    return realRoot;
}
function parseAllowedRoots(value) {
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
        }
        catch {
            return path.resolve(entry);
        }
    });
}
function isGitRepoRoot(root) {
    try {
        return fs.existsSync(path.join(root, '.git'));
    }
    catch {
        return false;
    }
}
function resolvePathWithinProject(projectRoot, filePath) {
    const root = path.resolve(projectRoot);
    const resolved = path.resolve(root, filePath.startsWith(root) ? path.relative(root, filePath) : filePath);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        throw new Error(`Path escapes project root: ${filePath}`);
    }
    const realRoot = fs.realpathSync.native(root);
    let realResolved;
    try {
        realResolved = fs.realpathSync.native(resolved);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            const parent = path.dirname(resolved);
            const realParent = fs.realpathSync.native(parent);
            realResolved = path.join(realParent, path.basename(resolved));
        }
        else {
            throw error;
        }
    }
    if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
        throw new Error(`Path escapes project root via symlink: ${filePath}`);
    }
    return resolved;
}
//# sourceMappingURL=path-guard.js.map