export type ScannerCapability =
  | 'process'
  | 'log'
  | 'hook'
  | 'extension'
  | 'terminal'
  | 'lm';

export type TrustTier = 'official' | 'verified' | 'community';

export type ContentPolicy = 'metadata-only' | 'redacted' | 'full';

export interface LogPathConfig {
  glob: string;
  parser: string;
  watchMode: 'tail' | 'poll' | 'once';
}

export interface HookInstallerConfig {
  configPath: string;
  forwarder: string;
  events: string[];
}

export interface TokenFieldsConfig {
  input?: string;
  output?: string;
  cacheRead?: string;
  cacheWrite?: string;
  reasoning?: string;
  model?: string;
}

export interface ScannerManifest {
  $schema?: string;
  id: string;
  version: string;
  displayName: string;
  publisher: string;
  trust: TrustTier;
  minDaemon?: string;
  minProtocol?: string;
  capabilities: ScannerCapability[];
  processPatterns?: string[];
  logPaths?: LogPathConfig[];
  hookInstaller?: HookInstallerConfig;
  tokenFields?: TokenFieldsConfig;
  fileChangeTools?: string[];
  allowedFields?: string[];
  redactedFields?: string[];
  contentPolicy?: ContentPolicy;
  enabled?: boolean;
  signature?: string;
  bundleHash?: string;
}

export interface ScanContext {
  processes: string[];
  timestamp: string;
  cwd?: string;
  extensionReports?: ExtensionReport[];
}

export interface ExtensionReport {
  extensionId: string;
  active: boolean;
  timestamp: string;
}

export interface Evidence {
  type: 'process' | 'log_line' | 'hook_event' | 'extension_report';
  timestamp: string;
  hash: string;
}

export interface ScanResult {
  tool: string;
  confidence: number;
  evidence: Evidence[];
  sessionId?: string;
}

export interface ParsedTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  model?: string;
  isEstimated: boolean;
}

export interface ParsedLogEvent {
  parserId: string;
  lineHash: string;
  timestamp: string;
  sessionId?: string;
  eventType?: string;
  toolName?: string;
  tokens?: ParsedTokenUsage;
  filePathHash?: string;
  metadata: Record<string, unknown>;
}

export interface Parser {
  id: string;
  parseLine(line: string, lineNumber?: number): ParsedLogEvent | null;
  parseChunk(text: string): ParsedLogEvent[];
}

export interface RegistryHostOptions {
  timeoutMs?: number;
  workerResourceLimits?: {
    maxOldGenerationSizeMb?: number;
  };
}

export interface SandboxWorkerRequest {
  kind: 'scan' | 'parse';
  manifest?: ScannerManifest;
  parserId?: string;
  line?: string;
  ctx?: ScanContext;
}

export interface SandboxWorkerResponse {
  ok: boolean;
  result?: ScanResult | ParsedLogEvent | null;
  error?: string;
}