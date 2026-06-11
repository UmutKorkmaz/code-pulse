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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const nodePath = __importStar(require("path"));
// Compiled core path guard — import via relative path to dist for tests
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTrustedProjectRoot, resolvePathWithinProject } = require('../../../packages/core/dist/snapshots/path-guard.js');
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
        assert_1.default.throws(() => resolvePathWithinProject(projectRoot, '../escape'), /escapes project root/);
    });
    it('rejects an absolute path outside the project root', () => {
        assert_1.default.throws(() => resolvePathWithinProject(projectRoot, '/etc/passwd'), /escapes project root/);
    });
    it('rejects a symlinked directory that escapes the project root', () => {
        // Arrange: project/link -> sibling dir outside the root.
        const outside = nodePath.join(tempDir, 'outside');
        fs.mkdirSync(outside);
        fs.writeFileSync(nodePath.join(outside, 'secret.txt'), 'secret');
        fs.symlinkSync(outside, nodePath.join(projectRoot, 'link'));
        // Act + Assert
        assert_1.default.throws(() => resolvePathWithinProject(projectRoot, 'link/secret.txt'), /escapes project root via symlink/);
    });
    it('resolves a normal relative path inside the project root', () => {
        fs.mkdirSync(nodePath.join(projectRoot, 'src'));
        fs.writeFileSync(nodePath.join(projectRoot, 'src', 'app.ts'), 'export {};');
        const resolved = resolvePathWithinProject(projectRoot, 'src/app.ts');
        assert_1.default.strictEqual(resolved, nodePath.join(projectRoot, 'src', 'app.ts'));
    });
    it('accepts a git project root and returns its canonical path', () => {
        const realRoot = assertTrustedProjectRoot(projectRoot);
        assert_1.default.strictEqual(realRoot, fs.realpathSync.native(projectRoot));
    });
    it('rejects a project root without .git that is not allowlisted', () => {
        const bareDir = nodePath.join(tempDir, 'bare');
        fs.mkdirSync(bareDir);
        assert_1.default.throws(() => assertTrustedProjectRoot(bareDir), /must contain a \.git directory or be listed in CODEPULSE_ALLOWED_ROOTS/);
    });
    it('rejects relative, missing, and home project roots', () => {
        assert_1.default.throws(() => assertTrustedProjectRoot('relative/path'), /must be an absolute path/);
        assert_1.default.throws(() => assertTrustedProjectRoot(nodePath.join(tempDir, 'missing')), /does not exist/);
        assert_1.default.throws(() => assertTrustedProjectRoot(os.homedir()), /must not be the user home directory/);
    });
});
