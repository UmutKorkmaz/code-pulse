import {
  ENVELOPE_VERSION,
  MAX_FRAME_BYTES,
  type AISession,
  type AISessionSource,
  type AnyEnvelope,
  type ClientInfo,
  type CodingSession,
  type DaemonEvent,
  type Evidence,
  type FileChangeMeta,
  type FileSnapshotMeta,
  type RecoveryAction,
  type ScannerManifestSummary,
  type TokenUsage,
  type EnvelopeSource,
  type TrustTier,
} from './envelope';
import {
  SCANNER_MANIFEST_SCHEMA_URL,
  type ScannerCapability,
  type ScannerContentPolicy,
  type ScannerManifest,
} from './scanner-manifest';

export interface ValidationSuccess<T> {
  ok: true;
  value: T;
}

export interface ValidationFailure {
  ok: false;
  errors: string[];
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

function success<T>(value: T): ValidationSuccess<T> {
  return { ok: true, value };
}

function failure(errors: string[]): ValidationFailure {
  return { ok: false, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const ENVELOPE_SOURCES: readonly EnvelopeSource[] = [
  'daemon',
  'vscode',
  'desktop',
  'cli',
  'scanner',
];

const EVIDENCE_TYPES = [
  'process',
  'log_line',
  'hook_event',
  'extension_report',
  'terminal',
] as const;
const AI_SESSION_SOURCES: readonly AISessionSource[] = [
  'process',
  'log',
  'hook',
  'extension',
  'terminal',
  'lm',
];
const FILE_CHANGE_TYPES = ['create', 'modify', 'delete'] as const;
const SNAPSHOT_TYPES = ['pre_ai', 'checkpoint', 'post_ai', 'manual'] as const;
const TRUST_TIERS: readonly TrustTier[] = ['official', 'verified', 'community'];
const SCANNER_CAPABILITIES: readonly ScannerCapability[] = [
  'process',
  'log',
  'hook',
  'extension',
  'terminal',
  'lm',
];
const CONTENT_POLICIES: readonly ScannerContentPolicy[] = [
  'metadata-only',
  'redacted',
  'none',
];

/**
 * Maximum timestamp (ms) accepted on envelopes: the ECMAScript max Date value.
 * Anything larger makes `new Date(ts).toISOString()` throw downstream, which can
 * wedge the spool tailer on a single poisoned line.
 */
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/** ISO timestamp parseable into the same bounded Date range enforced for `ts`. */
function isBoundedIsoTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) && inRange(ms, 0, MAX_TIMESTAMP_MS);
}

function validateAiSession(input: unknown, path: string): ValidationResult<AISession> {
  if (!isRecord(input)) {
    return failure([`${path} must be an object`]);
  }

  const errors: string[] = [];

  for (const key of ['id', 'scannerId', 'tool', 'startedAt'] as const) {
    if (!isNonEmptyString(input[key])) {
      errors.push(`${path}.${key} must be a non-empty string`);
    }
  }

  if (!isFiniteNumber(input.confidence) || !inRange(input.confidence, 0, 1)) {
    errors.push(`${path}.confidence must be a number between 0 and 1`);
  }

  if (
    input.source !== undefined &&
    !AI_SESSION_SOURCES.includes(input.source as AISessionSource)
  ) {
    errors.push(
      `${path}.source must be one of: ${AI_SESSION_SOURCES.join(', ')} when present`,
    );
  }

  if (input.lastActivityAt !== undefined && !isBoundedIsoTimestamp(input.lastActivityAt)) {
    errors.push(`${path}.lastActivityAt must be a valid ISO-8601 timestamp when present`);
  }

  for (const key of ['activeDuration', 'runDuration'] as const) {
    const value = input[key];
    if (value !== undefined && (!isFiniteNumber(value) || value < 0)) {
      errors.push(`${path}.${key} must be a non-negative number when present`);
    }
  }

  if (errors.length > 0) {
    return failure(errors);
  }

  return success({
    id: input.id as string,
    sessionId: input.sessionId as string | undefined,
    scannerId: input.scannerId as string,
    tool: input.tool as string,
    model: input.model as string | undefined,
    startedAt: input.startedAt as string,
    endedAt: input.endedAt as string | undefined,
    confidence: input.confidence as number,
    source: input.source as AISessionSource | undefined,
    lastActivityAt: input.lastActivityAt as string | undefined,
    activeDuration: input.activeDuration as number | undefined,
    runDuration: input.runDuration as number | undefined,
  });
}

export function validateEvidence(input: unknown, path = 'evidence'): ValidationResult<Evidence> {
  if (!isRecord(input)) {
    return failure([`${path} must be an object`]);
  }

  const errors: string[] = [];

  if (!EVIDENCE_TYPES.includes(input.type as (typeof EVIDENCE_TYPES)[number])) {
    errors.push(`${path}.type must be one of: ${EVIDENCE_TYPES.join(', ')}`);
  }

  if (!isNonEmptyString(input.timestamp)) {
    errors.push(`${path}.timestamp must be a non-empty string`);
  }

  if (!isNonEmptyString(input.hash)) {
    errors.push(`${path}.hash must be a non-empty string`);
  }

  if (errors.length > 0) {
    return failure(errors);
  }

  return success({
    type: input.type as Evidence['type'],
    timestamp: input.timestamp as string,
    hash: input.hash as string,
  });
}

export function validateTokenUsage(input: unknown, path = 'usage'): ValidationResult<TokenUsage> {
  if (!isRecord(input)) {
    return failure([`${path} must be an object`]);
  }

  const errors: string[] = [];

  if (!isFiniteNumber(input.inputTokens) || input.inputTokens < 0) {
    errors.push(`${path}.inputTokens must be a non-negative number`);
  }

  if (!isFiniteNumber(input.outputTokens) || input.outputTokens < 0) {
    errors.push(`${path}.outputTokens must be a non-negative number`);
  }

  if (input.cacheReadTokens !== undefined) {
    if (!isFiniteNumber(input.cacheReadTokens) || input.cacheReadTokens < 0) {
      errors.push(`${path}.cacheReadTokens must be a non-negative number when present`);
    }
  }

  if (input.cacheWriteTokens !== undefined) {
    if (!isFiniteNumber(input.cacheWriteTokens) || input.cacheWriteTokens < 0) {
      errors.push(`${path}.cacheWriteTokens must be a non-negative number when present`);
    }
  }

  if (input.reasoningTokens !== undefined) {
    if (!isFiniteNumber(input.reasoningTokens) || input.reasoningTokens < 0) {
      errors.push(`${path}.reasoningTokens must be a non-negative number when present`);
    }
  }

  if (!isFiniteNumber(input.totalTokens) || input.totalTokens < 0) {
    errors.push(`${path}.totalTokens must be a non-negative number`);
  }

  if (typeof input.isEstimated !== 'boolean') {
    errors.push(`${path}.isEstimated must be a boolean`);
  }

  if (input.model !== undefined && typeof input.model !== 'string') {
    errors.push(`${path}.model must be a string when present`);
  }

  if (input.currency !== undefined && typeof input.currency !== 'string') {
    errors.push(`${path}.currency must be a string when present`);
  }

  if (input.estimatedCost !== undefined) {
    if (!isFiniteNumber(input.estimatedCost) || input.estimatedCost < 0) {
      errors.push(`${path}.estimatedCost must be a non-negative number when present`);
    }
  }

  if (errors.length > 0) {
    return failure(errors);
  }

  return success({
    inputTokens: input.inputTokens as number,
    outputTokens: input.outputTokens as number,
    cacheReadTokens: input.cacheReadTokens as number | undefined,
    cacheWriteTokens: input.cacheWriteTokens as number | undefined,
    reasoningTokens: input.reasoningTokens as number | undefined,
    totalTokens: input.totalTokens as number,
    model: input.model as string | undefined,
    currency: input.currency as string | undefined,
    estimatedCost: input.estimatedCost as number | undefined,
    isEstimated: input.isEstimated as boolean,
    aiSessionId: input.aiSessionId as string | undefined,
    scannerId: input.scannerId as string | undefined,
    tool: input.tool as string | undefined,
  });
}

export function validateFileChangeMeta(
  input: unknown,
  path = 'change',
): ValidationResult<FileChangeMeta> {
  if (!isRecord(input)) {
    return failure([`${path} must be an object`]);
  }

  const errors: string[] = [];

  if (!isNonEmptyString(input.pathHash)) {
    errors.push(`${path}.pathHash must be a non-empty string`);
  }

  if (input.repoRootHash !== undefined && !isNonEmptyString(input.repoRootHash)) {
    errors.push(`${path}.repoRootHash must be a non-empty string when present`);
  }

  if (!FILE_CHANGE_TYPES.includes(input.changeType as (typeof FILE_CHANGE_TYPES)[number])) {
    errors.push(`${path}.changeType must be one of: ${FILE_CHANGE_TYPES.join(', ')}`);
  }

  if (!isFiniteNumber(input.linesAdded) || input.linesAdded < 0) {
    errors.push(`${path}.linesAdded must be a non-negative number`);
  }

  if (!isFiniteNumber(input.linesRemoved) || input.linesRemoved < 0) {
    errors.push(`${path}.linesRemoved must be a non-negative number`);
  }

  if (typeof input.aiAttributed !== 'boolean') {
    errors.push(`${path}.aiAttributed must be a boolean`);
  }

  if (input.language !== undefined && typeof input.language !== 'string') {
    errors.push(`${path}.language must be a string when present`);
  }

  if (input.aiSessionId !== undefined && !isNonEmptyString(input.aiSessionId)) {
    errors.push(`${path}.aiSessionId must be a non-empty string when present`);
  }

  if (errors.length > 0) {
    return failure(errors);
  }

  return success({
    pathHash: input.pathHash as string,
    repoRootHash: input.repoRootHash as string | undefined,
    changeType: input.changeType as FileChangeMeta['changeType'],
    linesAdded: input.linesAdded as number,
    linesRemoved: input.linesRemoved as number,
    language: input.language as string | undefined,
    aiAttributed: input.aiAttributed as boolean,
    aiSessionId: input.aiSessionId as string | undefined,
  });
}

function validateCodingSession(input: unknown, path: string): ValidationResult<CodingSession> {
  if (!isRecord(input)) {
    return failure([`${path} must be an object`]);
  }

  const errors: string[] = [];
  const requiredStrings = [
    'id',
    'startTime',
    'project',
    'language',
    'file',
  ] as const;

  for (const key of requiredStrings) {
    if (!isNonEmptyString(input[key])) {
      errors.push(`${path}.${key} must be a non-empty string`);
    }
  }

  if (!isFiniteNumber(input.duration) || input.duration < 0) {
    errors.push(`${path}.duration must be a non-negative number`);
  }

  if (!isFiniteNumber(input.idleDuration) || input.idleDuration < 0) {
    errors.push(`${path}.idleDuration must be a non-negative number`);
  }

  if (typeof input.isActive !== 'boolean') {
    errors.push(`${path}.isActive must be a boolean`);
  }

  for (const counter of ['heartbeats', 'keystrokes', 'linesAdded', 'linesRemoved'] as const) {
    if (!isFiniteNumber(input[counter]) || input[counter] < 0) {
      errors.push(`${path}.${counter} must be a non-negative number`);
    }
  }

  if (errors.length > 0) {
    return failure(errors);
  }

  return success({
    id: input.id as string,
    startTime: input.startTime as string,
    endTime: input.endTime as string | undefined,
    duration: input.duration as number,
    idleDuration: input.idleDuration as number,
    project: input.project as string,
    language: input.language as string,
    file: input.file as string,
    branch: input.branch as string | undefined,
    isActive: input.isActive as boolean,
    heartbeats: input.heartbeats as number,
    keystrokes: input.keystrokes as number,
    linesAdded: input.linesAdded as number,
    linesRemoved: input.linesRemoved as number,
    productivityScore: input.productivityScore as number | undefined,
    tags: input.tags as string[] | undefined,
    aiAssisted: input.aiAssisted as boolean | undefined,
  });
}

function validateFileSnapshotMeta(
  input: unknown,
  path: string,
): ValidationResult<FileSnapshotMeta> {
  if (!isRecord(input)) {
    return failure([`${path} must be an object`]);
  }

  const errors: string[] = [];

  for (const key of ['id', 'project', 'pathHash', 'createdAt'] as const) {
    if (!isNonEmptyString(input[key])) {
      errors.push(`${path}.${key} must be a non-empty string`);
    }
  }

  if (!SNAPSHOT_TYPES.includes(input.snapshotType as (typeof SNAPSHOT_TYPES)[number])) {
    errors.push(`${path}.snapshotType must be one of: ${SNAPSHOT_TYPES.join(', ')}`);
  }

  if (input.sizeBytes !== undefined) {
    if (!isFiniteNumber(input.sizeBytes) || input.sizeBytes < 0) {
      errors.push(`${path}.sizeBytes must be a non-negative number when present`);
    }
  }

  if (errors.length > 0) {
    return failure(errors);
  }

  return success({
    id: input.id as string,
    aiSessionId: input.aiSessionId as string | undefined,
    sessionId: input.sessionId as string | undefined,
    project: input.project as string,
    pathHash: input.pathHash as string,
    snapshotType: input.snapshotType as FileSnapshotMeta['snapshotType'],
    diffPath: input.diffPath as string | undefined,
    fileHashBefore: input.fileHashBefore as string | undefined,
    fileHashAfter: input.fileHashAfter as string | undefined,
    sizeBytes: input.sizeBytes as number | undefined,
    createdAt: input.createdAt as string,
  });
}

function validateRecoveryAction(input: unknown, path: string): ValidationResult<RecoveryAction> {
  if (!isRecord(input)) {
    return failure([`${path} must be an object`]);
  }

  const errors: string[] = [];
  const required = ['id', 'snapshotId', 'action', 'correlationId', 'occurredAt'] as const;

  for (const key of required) {
    if (!isNonEmptyString(input[key])) {
      errors.push(`${path}.${key} must be a non-empty string`);
    }
  }

  if (!isFiniteNumber(input.filesAffected) || input.filesAffected < 0) {
    errors.push(`${path}.filesAffected must be a non-negative number`);
  }

  if (errors.length > 0) {
    return failure(errors);
  }

  return success({
    id: input.id as string,
    aiSessionId: input.aiSessionId as string | undefined,
    snapshotId: input.snapshotId as string,
    action: input.action as RecoveryAction['action'],
    correlationId: input.correlationId as string,
    filesAffected: input.filesAffected as number,
    occurredAt: input.occurredAt as string,
    dryRun: input.dryRun as boolean | undefined,
    error: input.error as string | undefined,
  });
}

function validateClientInfo(input: unknown, path: string): ValidationResult<ClientInfo> {
  if (!isRecord(input)) {
    return failure([`${path} must be an object`]);
  }

  const errors: string[] = [];

  if (!isNonEmptyString(input.id)) {
    errors.push(`${path}.id must be a non-empty string`);
  }

  if (!['vscode', 'desktop', 'cli'].includes(input.kind as string)) {
    errors.push(`${path}.kind must be vscode, desktop, or cli`);
  }

  if (!isNonEmptyString(input.connectedAt)) {
    errors.push(`${path}.connectedAt must be a non-empty string`);
  }

  if (errors.length > 0) {
    return failure(errors);
  }

  return success({
    id: input.id as string,
    kind: input.kind as ClientInfo['kind'],
    version: input.version as string | undefined,
    connectedAt: input.connectedAt as string,
  });
}

function validateScannerManifestSummary(
  input: unknown,
  path: string,
): ValidationResult<ScannerManifestSummary> {
  if (!isRecord(input)) {
    return failure([`${path} must be an object`]);
  }

  const errors: string[] = [];

  for (const key of ['id', 'version', 'displayName'] as const) {
    if (!isNonEmptyString(input[key])) {
      errors.push(`${path}.${key} must be a non-empty string`);
    }
  }

  if (!TRUST_TIERS.includes(input.trust as TrustTier)) {
    errors.push(`${path}.trust must be one of: ${TRUST_TIERS.join(', ')}`);
  }

  if (typeof input.enabled !== 'boolean') {
    errors.push(`${path}.enabled must be a boolean`);
  }

  if (errors.length > 0) {
    return failure(errors);
  }

  return success({
    id: input.id as string,
    version: input.version as string,
    displayName: input.displayName as string,
    trust: input.trust as TrustTier,
    enabled: input.enabled as boolean,
    lastScanAt: input.lastScanAt as string | undefined,
    evidenceCount: input.evidenceCount as number | undefined,
  });
}

export function validateDaemonEvent(
  input: unknown,
  path = 'payload',
): ValidationResult<DaemonEvent> {
  if (!isRecord(input)) {
    return failure([`${path} must be an object`]);
  }

  if (!isNonEmptyString(input.type)) {
    return failure([`${path}.type must be a non-empty string`]);
  }

  switch (input.type) {
    case 'session.started':
    case 'session.updated':
    case 'session.ended': {
      const session = validateCodingSession(input.session, `${path}.session`);
      if (!session.ok) {
        return session;
      }
      return success({ type: input.type, session: session.value });
    }

    case 'ai.tool.detected': {
      const errors: string[] = [];
      if (!isNonEmptyString(input.tool)) {
        errors.push(`${path}.tool must be a non-empty string`);
      }
      if (!isFiniteNumber(input.confidence) || !inRange(input.confidence, 0, 1)) {
        errors.push(`${path}.confidence must be a number between 0 and 1`);
      }
      if (!Array.isArray(input.evidence)) {
        errors.push(`${path}.evidence must be an array`);
      } else {
        const evidence: Evidence[] = [];
        for (let i = 0; i < input.evidence.length; i++) {
          const item = validateEvidence(input.evidence[i], `${path}.evidence[${i}]`);
          if (!item.ok) {
            errors.push(...item.errors);
          } else {
            evidence.push(item.value);
          }
        }
        if (errors.length === 0) {
          return success({
            type: 'ai.tool.detected',
            tool: input.tool as string,
            confidence: input.confidence as number,
            evidence,
            scannerId: input.scannerId as string | undefined,
          });
        }
      }
      return failure(errors);
    }

    case 'ai.session.started':
    case 'ai.session.updated':
    case 'ai.session.ended': {
      const aiSession = validateAiSession(input.aiSession, `${path}.aiSession`);
      if (!aiSession.ok) {
        return aiSession;
      }
      return success({ type: input.type, aiSession: aiSession.value });
    }

    case 'ai.tokens': {
      const usage = validateTokenUsage(input.usage, `${path}.usage`);
      if (!usage.ok) {
        return usage;
      }
      return success({ type: 'ai.tokens', usage: usage.value });
    }

    case 'file.snapshot': {
      const snapshot = validateFileSnapshotMeta(input.snapshot, `${path}.snapshot`);
      if (!snapshot.ok) {
        return snapshot;
      }
      return success({ type: 'file.snapshot', snapshot: snapshot.value });
    }

    case 'file.change': {
      const change = validateFileChangeMeta(input.change, `${path}.change`);
      if (!change.ok) {
        return change;
      }
      return success({ type: 'file.change', change: change.value });
    }

    case 'recovery.action': {
      const action = validateRecoveryAction(input.action, `${path}.action`);
      if (!action.ok) {
        return action;
      }
      return success({ type: 'recovery.action', action: action.value });
    }

    case 'registry.updated': {
      if (!Array.isArray(input.scanners)) {
        return failure([`${path}.scanners must be an array`]);
      }
      const scanners: ScannerManifestSummary[] = [];
      const errors: string[] = [];
      for (let i = 0; i < input.scanners.length; i++) {
        const item = validateScannerManifestSummary(
          input.scanners[i],
          `${path}.scanners[${i}]`,
        );
        if (!item.ok) {
          errors.push(...item.errors);
        } else {
          scanners.push(item.value);
        }
      }
      if (errors.length > 0) {
        return failure(errors);
      }
      return success({ type: 'registry.updated', scanners });
    }

    case 'scanner.quarantined': {
      const errors: string[] = [];
      if (!isNonEmptyString(input.scannerId)) {
        errors.push(`${path}.scannerId must be a non-empty string`);
      }
      if (!isNonEmptyString(input.reason)) {
        errors.push(`${path}.reason must be a non-empty string`);
      }
      if (input.errorRate !== undefined && !isFiniteNumber(input.errorRate)) {
        errors.push(`${path}.errorRate must be a finite number when present`);
      }
      if (input.threshold !== undefined && !isFiniteNumber(input.threshold)) {
        errors.push(`${path}.threshold must be a finite number when present`);
      }
      if (input.eventsDropped !== undefined) {
        if (!isFiniteNumber(input.eventsDropped) || input.eventsDropped < 0) {
          errors.push(`${path}.eventsDropped must be a non-negative number when present`);
        }
      }
      if (errors.length > 0) {
        return failure(errors);
      }
      return success({
        type: 'scanner.quarantined',
        scannerId: input.scannerId as string,
        reason: input.reason as string,
        version: input.version as string | undefined,
        errorRate: input.errorRate as number | undefined,
        threshold: input.threshold as number | undefined,
        eventsDropped: input.eventsDropped as number | undefined,
      });
    }

    case 'client.connected': {
      const client = validateClientInfo(input.client, `${path}.client`);
      if (!client.ok) {
        return client;
      }
      return success({ type: 'client.connected', client: client.value });
    }

    default:
      return failure([`${path}.type is not a recognized daemon event: ${String(input.type)}`]);
  }
}

export function validateEnvelope(input: unknown): ValidationResult<AnyEnvelope> {
  if (!isRecord(input)) {
    return failure(['envelope must be an object']);
  }

  const errors: string[] = [];

  if (input.v !== ENVELOPE_VERSION) {
    errors.push(`envelope.v must be ${ENVELOPE_VERSION}`);
  }

  if (!isNonEmptyString(input.id)) {
    errors.push('envelope.id must be a non-empty string');
  }

  if (!isFiniteNumber(input.ts) || input.ts < 0 || input.ts > MAX_TIMESTAMP_MS) {
    errors.push(`envelope.ts must be a number between 0 and ${MAX_TIMESTAMP_MS}`);
  }

  if (!ENVELOPE_SOURCES.includes(input.src as EnvelopeSource)) {
    errors.push(`envelope.src must be one of: ${ENVELOPE_SOURCES.join(', ')}`);
  }

  if (input.corr !== undefined && !isNonEmptyString(input.corr)) {
    errors.push('envelope.corr must be a non-empty string when present');
  }

  const payload = validateDaemonEvent(input.payload, 'payload');
  if (!payload.ok) {
    errors.push(...payload.errors);
  } else if (input.type !== payload.value.type) {
    errors.push('envelope.type must match payload.type');
  }

  if (errors.length > 0 || !payload.ok) {
    return failure(errors);
  }

  return success({
    v: ENVELOPE_VERSION,
    id: input.id as string,
    ts: input.ts as number,
    src: input.src as EnvelopeSource,
    corr: input.corr as string | undefined,
    type: payload.value.type,
    payload: payload.value,
  });
}

/** Reject frames larger than the daemon ingest limit. */
export function validateFrameSize(byteLength: number): ValidationResult<number> {
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    return failure(['byteLength must be a non-negative finite number']);
  }
  if (byteLength > MAX_FRAME_BYTES) {
    return failure([`frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes`]);
  }
  return success(byteLength);
}

export function validateScannerManifest(input: unknown): ValidationResult<ScannerManifest> {
  if (!isRecord(input)) {
    return failure(['manifest must be an object']);
  }

  const errors: string[] = [];

  if (
    input.$schema !== undefined &&
    input.$schema !== SCANNER_MANIFEST_SCHEMA_URL
  ) {
    errors.push(`$schema must be ${SCANNER_MANIFEST_SCHEMA_URL} when present`);
  }

  for (const key of [
    'id',
    'version',
    'displayName',
    'publisher',
    'minDaemon',
    'minProtocol',
    'signature',
    'bundleHash',
  ] as const) {
    if (!isNonEmptyString(input[key])) {
      errors.push(`manifest.${key} must be a non-empty string`);
    }
  }

  if (!TRUST_TIERS.includes(input.trust as TrustTier)) {
    errors.push(`manifest.trust must be one of: ${TRUST_TIERS.join(', ')}`);
  }

  if (!CONTENT_POLICIES.includes(input.contentPolicy as ScannerContentPolicy)) {
    errors.push(`manifest.contentPolicy must be one of: ${CONTENT_POLICIES.join(', ')}`);
  }

  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    errors.push('manifest.capabilities must be a non-empty array');
  } else {
    for (const capability of input.capabilities) {
      if (!SCANNER_CAPABILITIES.includes(capability as ScannerCapability)) {
        errors.push(
          `manifest.capabilities contains invalid value: ${String(capability)}`,
        );
      }
    }
  }

  if (input.processPatterns !== undefined && !isStringArray(input.processPatterns)) {
    errors.push('manifest.processPatterns must be a string array when present');
  }

  if (input.logPaths !== undefined) {
    if (!Array.isArray(input.logPaths)) {
      errors.push('manifest.logPaths must be an array when present');
    } else {
      for (let i = 0; i < input.logPaths.length; i++) {
        const entry = input.logPaths[i];
        if (!isRecord(entry)) {
          errors.push(`manifest.logPaths[${i}] must be an object`);
          continue;
        }
        if (!isNonEmptyString(entry.glob)) {
          errors.push(`manifest.logPaths[${i}].glob must be a non-empty string`);
        }
        if (!isNonEmptyString(entry.parser)) {
          errors.push(`manifest.logPaths[${i}].parser must be a non-empty string`);
        }
        if (!['tail', 'poll', 'once'].includes(entry.watchMode as string)) {
          errors.push(`manifest.logPaths[${i}].watchMode must be tail, poll, or once`);
        }
      }
    }
  }

  if (input.hookInstaller !== undefined) {
    const hook = input.hookInstaller;
    if (!isRecord(hook)) {
      errors.push('manifest.hookInstaller must be an object when present');
    } else {
      if (!isNonEmptyString(hook.configPath)) {
        errors.push('manifest.hookInstaller.configPath must be a non-empty string');
      }
      if (!isNonEmptyString(hook.forwarder)) {
        errors.push('manifest.hookInstaller.forwarder must be a non-empty string');
      }
      if (!isStringArray(hook.events) || hook.events.length === 0) {
        errors.push('manifest.hookInstaller.events must be a non-empty string array');
      }
    }
  }

  if (input.tokenFields !== undefined) {
    const fields = input.tokenFields;
    if (!isRecord(fields)) {
      errors.push('manifest.tokenFields must be an object when present');
    } else {
      if (!isNonEmptyString(fields.input)) {
        errors.push('manifest.tokenFields.input must be a non-empty string');
      }
      if (!isNonEmptyString(fields.output)) {
        errors.push('manifest.tokenFields.output must be a non-empty string');
      }
    }
  }

  if (input.fileChangeTools !== undefined && !isStringArray(input.fileChangeTools)) {
    errors.push('manifest.fileChangeTools must be a string array when present');
  }

  if (input.allowedFields !== undefined && !isStringArray(input.allowedFields)) {
    errors.push('manifest.allowedFields must be a string array when present');
  }

  if (input.redactedFields !== undefined && !isStringArray(input.redactedFields)) {
    errors.push('manifest.redactedFields must be a string array when present');
  }

  if (errors.length > 0) {
    return failure(errors);
  }

  return success({
    $schema: input.$schema as typeof SCANNER_MANIFEST_SCHEMA_URL | undefined,
    id: input.id as string,
    version: input.version as string,
    displayName: input.displayName as string,
    publisher: input.publisher as string,
    trust: input.trust as TrustTier,
    minDaemon: input.minDaemon as string,
    minProtocol: input.minProtocol as string,
    capabilities: input.capabilities as ScannerCapability[],
    processPatterns: input.processPatterns as string[] | undefined,
    logPaths: input.logPaths as ScannerManifest['logPaths'],
    hookInstaller: input.hookInstaller as ScannerManifest['hookInstaller'],
    tokenFields: input.tokenFields as ScannerManifest['tokenFields'],
    fileChangeTools: input.fileChangeTools as string[] | undefined,
    allowedFields: input.allowedFields as string[] | undefined,
    redactedFields: input.redactedFields as string[] | undefined,
    contentPolicy: input.contentPolicy as ScannerContentPolicy,
    signature: input.signature as string,
    bundleHash: input.bundleHash as string,
  });
}