import * as fs from 'fs';
import * as path from 'path';
import type { ScannerManifestSummary } from '@codepulse/protocol';

/** Bundled official scanners shipped with the daemon (platform/registry-catalog). */
export function bundledCatalogDir(): string {
    // dist/main.js → apps/daemon/dist → ../../../registry-catalog
    return path.resolve(__dirname, '..', '..', '..', 'registry-catalog');
}

/** Copy bundled manifests into ~/.codepulse/cache/registry when cache is empty. */
export function seedRegistryIfEmpty(registryDir: string): number {
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

export function loadInstalledScanners(registryDir: string): ScannerManifestSummary[] {
    if (!fs.existsSync(registryDir)) {
        return [];
    }

    const scanners: ScannerManifestSummary[] = [];

    for (const entry of fs.readdirSync(registryDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
        }

        try {
            const raw = fs.readFileSync(path.join(registryDir, entry.name), 'utf8');
            const manifest = JSON.parse(raw) as Partial<ScannerManifestSummary> & {
                displayName?: string;
                trust?: ScannerManifestSummary['trust'];
            };

            if (!manifest.id || !manifest.version) {
                continue;
            }

            scanners.push({
                id: manifest.id,
                version: manifest.version,
                displayName: manifest.displayName ?? manifest.id,
                trust: manifest.trust ?? 'community',
                enabled:
                    manifest.enabled ??
                    (manifest.trust === 'official' || manifest.trust === 'verified')
            });
        } catch {
            // Skip invalid manifest files in MVP mode.
        }
    }

    return scanners.sort((a, b) => a.id.localeCompare(b.id));
}