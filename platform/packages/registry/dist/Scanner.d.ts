import type { ScanContext, ScanResult } from './types';
export interface Scanner {
    id: string;
    version: string;
    capabilities: Array<'process' | 'log' | 'hook' | 'extension' | 'terminal' | 'lm'>;
    match(ctx: ScanContext): Promise<ScanResult>;
}
export type { ScanContext, ScanResult, Evidence } from './types.js';
//# sourceMappingURL=Scanner.d.ts.map