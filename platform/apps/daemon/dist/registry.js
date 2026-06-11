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
exports.bundledCatalogDir = bundledCatalogDir;
exports.seedRegistryIfEmpty = seedRegistryIfEmpty;
exports.loadInstalledScanners = loadInstalledScanners;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** Bundled official scanners shipped with the daemon (platform/registry-catalog). */
function bundledCatalogDir() {
    // dist/main.js → apps/daemon/dist → ../../../registry-catalog
    return path.resolve(__dirname, '..', '..', '..', 'registry-catalog');
}
/** Copy bundled manifests into ~/.codepulse/cache/registry when cache is empty. */
function seedRegistryIfEmpty(registryDir) {
    if (!fs.existsSync(registryDir)) {
        fs.mkdirSync(registryDir, { recursive: true });
    }
    const existing = fs.readdirSync(registryDir).filter(name => name.endsWith('.json'));
    if (existing.length > 0) {
        return 0;
    }
    const bundled = bundledCatalogDir();
    if (!fs.existsSync(bundled)) {
        return 0;
    }
    let copied = 0;
    for (const name of fs.readdirSync(bundled)) {
        if (!name.endsWith('.json')) {
            continue;
        }
        fs.copyFileSync(path.join(bundled, name), path.join(registryDir, name));
        copied += 1;
    }
    return copied;
}
function loadInstalledScanners(registryDir) {
    if (!fs.existsSync(registryDir)) {
        return [];
    }
    const scanners = [];
    for (const entry of fs.readdirSync(registryDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
        }
        try {
            const raw = fs.readFileSync(path.join(registryDir, entry.name), 'utf8');
            const manifest = JSON.parse(raw);
            if (!manifest.id || !manifest.version) {
                continue;
            }
            scanners.push({
                id: manifest.id,
                version: manifest.version,
                displayName: manifest.displayName ?? manifest.id,
                trust: manifest.trust ?? 'community',
                enabled: manifest.enabled ??
                    (manifest.trust === 'official' || manifest.trust === 'verified')
            });
        }
        catch {
            // Skip invalid manifest files in MVP mode.
        }
    }
    return scanners.sort((a, b) => a.id.localeCompare(b.id));
}
//# sourceMappingURL=registry.js.map