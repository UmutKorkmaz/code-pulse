import type { Scanner } from './Scanner';
import type { ScannerManifest } from './types';
export interface LocalRegistryOptions {
    catalogDir: string;
}
export declare function defaultCatalogPath(): string;
export declare class LocalRegistry {
    private readonly catalogDir;
    private manifests;
    private scanners;
    constructor(options: LocalRegistryOptions | string);
    get catalogDirectory(): string;
    load(): Promise<ScannerManifest[]>;
    listManifests(): ScannerManifest[];
    getManifest(id: string): ScannerManifest | undefined;
    getScanner(id: string): Scanner | undefined;
    has(id: string): boolean;
    manifestHash(id: string): string | undefined;
    private readManifestFiles;
    private readManifestFile;
    private validateManifest;
}
//# sourceMappingURL=LocalRegistry.d.ts.map