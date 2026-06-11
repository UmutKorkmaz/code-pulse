import type { LocalRegistry } from './LocalRegistry';
import type { ParsedLogEvent, RegistryHostOptions, ScanContext, ScanResult } from './types';
export declare class RegistryHost {
    private readonly registry;
    private readonly timeoutMs;
    private readonly workerResourceLimits;
    constructor(registry: LocalRegistry, options?: RegistryHostOptions);
    scan(scannerId: string, ctx: ScanContext): Promise<ScanResult>;
    parseLogLine(parserId: string, line: string, options?: {
        useSandbox?: boolean;
    }): Promise<ParsedLogEvent | null>;
    parseLogChunk(parserId: string, text: string, options?: {
        useSandbox?: boolean;
    }): Promise<ParsedLogEvent[]>;
    listScannerIds(): string[];
    private runInSandbox;
}
//# sourceMappingURL=RegistryHost.d.ts.map