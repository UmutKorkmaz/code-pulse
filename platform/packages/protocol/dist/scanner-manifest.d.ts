import type { TrustTier } from './envelope';
export declare const SCANNER_MANIFEST_SCHEMA_URL = "https://registry.codepulse.dev/v1/scanner.schema.json";
export type ScannerCapability = 'process' | 'log' | 'hook' | 'extension' | 'terminal' | 'lm';
export type LogWatchMode = 'tail' | 'poll' | 'once';
export interface ScannerLogPath {
    /** Glob relative to user home (e.g. ~/.claude/projects/...jsonl). */
    glob: string;
    /** Parser bundle identifier loaded by the registry host. */
    parser: string;
    watchMode: LogWatchMode;
}
export interface ScannerHookInstaller {
    /** Tool config file receiving hook entries (e.g. `~/.claude/settings.json`). */
    configPath: string;
    /** Installed forwarder script path. */
    forwarder: string;
    /** Hook event names this scanner subscribes to. */
    events: string[];
}
export interface ScannerTokenFields {
    input: string;
    output: string;
    cacheRead?: string;
    cacheWrite?: string;
    model?: string;
    reasoning?: string;
}
export type ScannerContentPolicy = 'metadata-only' | 'redacted' | 'none';
/**
 * Signed scanner definition distributed via the curated registry CDN.
 * Matches the schema in platform strategy §4.2.
 */
export interface ScannerManifest {
    $schema?: typeof SCANNER_MANIFEST_SCHEMA_URL;
    id: string;
    version: string;
    displayName: string;
    publisher: string;
    trust: TrustTier;
    minDaemon: string;
    minProtocol: string;
    capabilities: ScannerCapability[];
    processPatterns?: string[];
    logPaths?: ScannerLogPath[];
    hookInstaller?: ScannerHookInstaller;
    tokenFields?: ScannerTokenFields;
    /** Tool names that imply filesystem mutations (used for snapshot triggers). */
    fileChangeTools?: string[];
    /** Fields parsers may emit past the daemon boundary. */
    allowedFields?: string[];
    /** Fields stripped before persistence even if present in source logs. */
    redactedFields?: string[];
    contentPolicy: ScannerContentPolicy;
    signature: string;
    bundleHash: string;
}
/** Registry index entry pointing at a full manifest. */
export interface RegistryIndexEntry {
    id: string;
    version: string;
    url: string;
    bundleHash: string;
    signature: string;
    publishedAt: string;
}
/** Top-level registry index fetched from the CDN. */
export interface RegistryIndex {
    schemaVersion: number;
    generatedAt: string;
    scanners: RegistryIndexEntry[];
}
//# sourceMappingURL=scanner-manifest.d.ts.map