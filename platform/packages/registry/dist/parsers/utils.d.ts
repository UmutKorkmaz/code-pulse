import type { ParsedTokenUsage } from '../types';
export declare function hashContent(value: string): string;
export declare function parseJsonLine<T extends Record<string, unknown>>(line: string): T | null;
export declare function pickNumber(source: Record<string, unknown>, keys: string[]): number | undefined;
export declare function pickString(source: Record<string, unknown>, keys: string[]): string | undefined;
export declare function extractUsage(source: Record<string, unknown>, fieldMap?: {
    input?: string;
    output?: string;
    cacheRead?: string;
    cacheWrite?: string;
    reasoning?: string;
    model?: string;
}, isEstimated?: boolean): ParsedTokenUsage | undefined;
export declare function resolveTimestamp(source: Record<string, unknown>, fallback?: string): string;
//# sourceMappingURL=utils.d.ts.map