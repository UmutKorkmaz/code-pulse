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
const path = __importStar(require("path"));
const registry_1 = require("@codepulse/registry");
const catalogDir = path.join(process.cwd(), 'registry-catalog');
function loadSignedManifest(file) {
    const raw = fs.readFileSync(path.join(catalogDir, file), 'utf8');
    return JSON.parse(raw);
}
describe('registry manifest ed25519 verification', () => {
    const unsignedOfficial = {
        id: 'scn.test',
        version: '1.0.0',
        displayName: 'Test',
        publisher: 'code-pulse-official',
        trust: 'official',
        capabilities: ['process']
    };
    it('accepts a validly signed official manifest from the catalog', () => {
        const manifest = loadSignedManifest('scn.claude-code.json');
        assert_1.default.ok(manifest.signature, 'catalog manifest should be signed');
        const result = (0, registry_1.verifyManifestSignature)(manifest);
        assert_1.default.strictEqual(result.ok, true, result.reason);
        assert_1.default.strictEqual(result.skipped, undefined);
    });
    it('rejects a signed manifest whose content was tampered with', () => {
        const manifest = loadSignedManifest('scn.claude-code.json');
        // Mutate a signed field; the content hash no longer matches the signature.
        const tampered = {
            ...manifest,
            processPatterns: ['evil', 'tail-anything']
        };
        const result = (0, registry_1.verifyManifestSignature)(tampered);
        assert_1.default.strictEqual(result.ok, false);
    });
    it('rejects a signed manifest with a forged/garbage signature', () => {
        const manifest = loadSignedManifest('scn.claude-code.json');
        const forged = {
            ...manifest,
            signature: Buffer.from('not-a-real-signature').toString('base64')
        };
        const result = (0, registry_1.verifyManifestSignature)(forged);
        assert_1.default.strictEqual(result.ok, false);
    });
    it('accepts an unsigned community manifest but marks it untrusted', () => {
        const result = (0, registry_1.verifyManifestSignature)({
            ...unsignedOfficial,
            trust: 'community'
        });
        assert_1.default.strictEqual(result.ok, true);
        assert_1.default.strictEqual(result.skipped, true);
    });
    it('rejects an unsigned official manifest', () => {
        const result = (0, registry_1.verifyManifestSignature)(unsignedOfficial);
        assert_1.default.strictEqual(result.ok, false);
    });
    it('rejects an unsigned verified manifest', () => {
        const result = (0, registry_1.verifyManifestSignature)({
            ...unsignedOfficial,
            trust: 'verified'
        });
        assert_1.default.strictEqual(result.ok, false);
    });
});
