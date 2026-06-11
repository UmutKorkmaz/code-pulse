import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import { createManifestScanner } from './manifestScanner';
import { verifyManifestSignature } from './signature';
import type { Scanner } from './Scanner';
import type { ScannerManifest } from './types';

export interface LocalRegistryOptions {
  catalogDir: string;
}

export function defaultCatalogPath(): string {
  return path.resolve(__dirname, '../../../registry-catalog');
}

export class LocalRegistry {
  private readonly catalogDir: string;
  private manifests = new Map<string, ScannerManifest>();
  private scanners = new Map<string, Scanner>();

  constructor(options: LocalRegistryOptions | string) {
    this.catalogDir =
      typeof options === 'string' ? options : options.catalogDir;
  }

  get catalogDirectory(): string {
    return this.catalogDir;
  }

  async load(): Promise<ScannerManifest[]> {
    this.manifests.clear();
    this.scanners.clear();

    const entries = await this.readManifestFiles();
    for (const manifest of entries) {
      this.manifests.set(manifest.id, manifest);
      this.scanners.set(manifest.id, createManifestScanner(manifest));
    }

    return this.listManifests();
  }

  listManifests(): ScannerManifest[] {
    return Array.from(this.manifests.values()).sort((left, right) =>
      left.displayName.localeCompare(right.displayName)
    );
  }

  getManifest(id: string): ScannerManifest | undefined {
    return this.manifests.get(id);
  }

  getScanner(id: string): Scanner | undefined {
    return this.scanners.get(id);
  }

  has(id: string): boolean {
    return this.manifests.has(id);
  }

  manifestHash(id: string): string | undefined {
    const manifest = this.manifests.get(id);
    if (!manifest) {
      return undefined;
    }

    return createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex');
  }

  private async readManifestFiles(): Promise<ScannerManifest[]> {
    let dirEntries: string[];

    try {
      dirEntries = await fs.readdir(this.catalogDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to read registry catalog at ${this.catalogDir}: ${message}`
      );
    }

    const manifests: ScannerManifest[] = [];

    for (const entry of dirEntries) {
      if (!entry.endsWith('.json')) {
        continue;
      }

      const filePath = path.join(this.catalogDir, entry);
      try {
        const manifest = await this.readManifestFile(filePath);
        manifests.push(manifest);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[registry] skipping invalid manifest ${entry}: ${message}`);
      }
    }

    return manifests;
  }

  private async readManifestFile(filePath: string): Promise<ScannerManifest> {
    const raw = await fs.readFile(filePath, 'utf8');
    const manifest = JSON.parse(raw) as ScannerManifest;
    this.validateManifest(manifest, filePath);
    const signature = verifyManifestSignature(manifest);
    if (!signature.ok) {
      throw new Error(
        `Invalid manifest ${filePath}: ${signature.reason ?? 'signature verification failed'}`
      );
    }
    return manifest;
  }

  private validateManifest(manifest: ScannerManifest, filePath: string): void {
    const required: Array<keyof ScannerManifest> = [
      'id',
      'version',
      'displayName',
      'publisher',
      'trust',
      'capabilities',
    ];

    for (const field of required) {
      if (manifest[field] === undefined || manifest[field] === null) {
        throw new Error(
          `Invalid manifest ${filePath}: missing required field "${field}"`
        );
      }
    }

    if (!Array.isArray(manifest.capabilities)) {
      throw new Error(
        `Invalid manifest ${filePath}: "capabilities" must be an array`
      );
    }
  }
}