"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalRegistry = void 0;
exports.defaultCatalogPath = defaultCatalogPath;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const manifestScanner_1 = require("./manifestScanner");
const signature_1 = require("./signature");
function defaultCatalogPath() {
    return path_1.default.resolve(__dirname, '../../../registry-catalog');
}
class LocalRegistry {
    constructor(options) {
        this.manifests = new Map();
        this.scanners = new Map();
        this.catalogDir =
            typeof options === 'string' ? options : options.catalogDir;
    }
    get catalogDirectory() {
        return this.catalogDir;
    }
    async load() {
        this.manifests.clear();
        this.scanners.clear();
        const entries = await this.readManifestFiles();
        for (const manifest of entries) {
            this.manifests.set(manifest.id, manifest);
            this.scanners.set(manifest.id, (0, manifestScanner_1.createManifestScanner)(manifest));
        }
        return this.listManifests();
    }
    listManifests() {
        return Array.from(this.manifests.values()).sort((left, right) => left.displayName.localeCompare(right.displayName));
    }
    getManifest(id) {
        return this.manifests.get(id);
    }
    getScanner(id) {
        return this.scanners.get(id);
    }
    has(id) {
        return this.manifests.has(id);
    }
    manifestHash(id) {
        const manifest = this.manifests.get(id);
        if (!manifest) {
            return undefined;
        }
        return (0, crypto_1.createHash)('sha256')
            .update(JSON.stringify(manifest))
            .digest('hex');
    }
    async readManifestFiles() {
        let dirEntries;
        try {
            dirEntries = await fs_1.promises.readdir(this.catalogDir);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to read registry catalog at ${this.catalogDir}: ${message}`);
        }
        const manifests = [];
        for (const entry of dirEntries) {
            if (!entry.endsWith('.json')) {
                continue;
            }
            const filePath = path_1.default.join(this.catalogDir, entry);
            try {
                const manifest = await this.readManifestFile(filePath);
                manifests.push(manifest);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[registry] skipping invalid manifest ${entry}: ${message}`);
            }
        }
        return manifests;
    }
    async readManifestFile(filePath) {
        const raw = await fs_1.promises.readFile(filePath, 'utf8');
        const manifest = JSON.parse(raw);
        this.validateManifest(manifest, filePath);
        const signature = (0, signature_1.verifyManifestSignature)(manifest);
        if (!signature.ok) {
            throw new Error(`Invalid manifest ${filePath}: ${signature.reason ?? 'signature verification failed'}`);
        }
        return manifest;
    }
    validateManifest(manifest, filePath) {
        const required = [
            'id',
            'version',
            'displayName',
            'publisher',
            'trust',
            'capabilities',
        ];
        for (const field of required) {
            if (manifest[field] === undefined || manifest[field] === null) {
                throw new Error(`Invalid manifest ${filePath}: missing required field "${field}"`);
            }
        }
        if (!Array.isArray(manifest.capabilities)) {
            throw new Error(`Invalid manifest ${filePath}: "capabilities" must be an array`);
        }
    }
}
exports.LocalRegistry = LocalRegistry;
//# sourceMappingURL=LocalRegistry.js.map