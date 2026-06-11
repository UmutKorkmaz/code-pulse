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
const core_1 = require("@codepulse/core");
const ORIGINAL_CONTENT = 'const answer = 42;\nexport { answer };\n';
const MUTATED_CONTENT = 'const answer = 0; // clobbered by AI\n';
describe('SnapshotManager', () => {
    let tempDir = '';
    let dataDir = '';
    let projectRoot = '';
    let trackedFile = '';
    let manager;
    beforeEach(async () => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-snap-'));
        dataDir = nodePath.join(tempDir, 'data');
        projectRoot = nodePath.join(tempDir, 'project');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(nodePath.join(projectRoot, '.git'), { recursive: true });
        fs.mkdirSync(nodePath.join(projectRoot, 'src'));
        trackedFile = nodePath.join(projectRoot, 'src', 'app.ts');
        fs.writeFileSync(trackedFile, ORIGINAL_CONTENT, 'utf8');
        manager = new core_1.SnapshotManager({ dataDir, database: new core_1.DatabaseV5(dataDir) });
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
        assert_1.default.strictEqual(dryRun.dryRun, true);
        assert_1.default.strictEqual(dryRun.wouldWrite, true);
        assert_1.default.strictEqual(dryRun.restored, false);
        assert_1.default.ok(dryRun.recoveryToken);
        assert_1.default.strictEqual(fs.readFileSync(trackedFile, 'utf8'), MUTATED_CONTENT);
        const confirmed = await manager.restoreSnapshot(snapshot.id, {
            dryRun: false,
            recoveryToken: dryRun.recoveryToken
        });
        // Assert
        assert_1.default.strictEqual(confirmed.restored, true);
        assert_1.default.strictEqual(fs.readFileSync(trackedFile, 'utf8'), ORIGINAL_CONTENT);
        assert_1.default.ok(confirmed.backupPath);
        assert_1.default.strictEqual(fs.readFileSync(confirmed.backupPath, 'utf8'), MUTATED_CONTENT);
    });
    it('rejects creating a snapshot for an untrusted project root', async () => {
        const bareRoot = nodePath.join(tempDir, 'untrusted');
        fs.mkdirSync(bareRoot);
        await assert_1.default.rejects(manager.createPreAiSnapshot({
            project: 'code-pulse',
            projectRoot: bareRoot,
            filePath: 'src/app.ts'
        }), core_1.UntrustedProjectRootError);
    });
    it('rejects creating a snapshot whose file path escapes the project root', async () => {
        await assert_1.default.rejects(manager.createPreAiSnapshot({
            project: 'code-pulse',
            projectRoot,
            filePath: '../escape.ts'
        }), /escapes project root/);
    });
    it('rejects restoring a blob whose projectRoot fails validation', async () => {
        // Arrange: tamper the persisted diff blob to point at an untrusted root.
        const snapshot = await manager.createPreAiSnapshot({
            project: 'code-pulse',
            projectRoot,
            filePath: 'src/app.ts'
        });
        assert_1.default.ok(snapshot.diff_path);
        const untrustedRoot = nodePath.join(tempDir, 'untrusted');
        fs.mkdirSync(untrustedRoot);
        const blob = JSON.parse(fs.readFileSync(snapshot.diff_path, 'utf8'));
        const tampered = { ...blob, projectRoot: untrustedRoot };
        fs.writeFileSync(snapshot.diff_path, JSON.stringify(tampered, null, 2), 'utf8');
        // Act + Assert: the trust check fails closed before any write.
        await assert_1.default.rejects(manager.restoreSnapshot(snapshot.id), core_1.UntrustedProjectRootError);
        assert_1.default.strictEqual(fs.readFileSync(trackedFile, 'utf8'), ORIGINAL_CONTENT);
    });
    it('rejects a confirmed restore without a valid recovery token', async () => {
        const snapshot = await manager.createPreAiSnapshot({
            project: 'code-pulse',
            projectRoot,
            filePath: 'src/app.ts'
        });
        fs.writeFileSync(trackedFile, MUTATED_CONTENT, 'utf8');
        await assert_1.default.rejects(manager.restoreSnapshot(snapshot.id, { dryRun: false, recoveryToken: 'bogus' }), /Valid recovery token required/);
        assert_1.default.strictEqual(fs.readFileSync(trackedFile, 'utf8'), MUTATED_CONTENT);
    });
});
