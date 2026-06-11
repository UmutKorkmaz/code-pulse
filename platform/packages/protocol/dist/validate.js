"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEvidence = validateEvidence;
exports.validateTokenUsage = validateTokenUsage;
exports.validateFileChangeMeta = validateFileChangeMeta;
exports.validateDaemonEvent = validateDaemonEvent;
exports.validateEnvelope = validateEnvelope;
exports.validateFrameSize = validateFrameSize;
exports.validateScannerManifest = validateScannerManifest;
const envelope_1 = require("./envelope");
const scanner_manifest_1 = require("./scanner-manifest");
function success(value) {
    return { ok: true, value };
}
function failure(errors) {
    return { ok: false, errors };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
const ENVELOPE_SOURCES = [
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
];
const AI_SESSION_SOURCES = [
    'process',
    'log',
    'hook',
    'extension',
    'terminal',
    'lm',
];
const FILE_CHANGE_TYPES = ['create', 'modify', 'delete'];
const SNAPSHOT_TYPES = ['pre_ai', 'checkpoint', 'post_ai', 'manual'];
const TRUST_TIERS = ['official', 'verified', 'community'];
const SCANNER_CAPABILITIES = [
    'process',
    'log',
    'hook',
    'extension',
    'terminal',
    'lm',
];
const CONTENT_POLICIES = [
    'metadata-only',
    'redacted',
    'none',
];
/**
 * Maximum timestamp (ms) accepted on envelopes: the ECMAScript max Date value.
 * Anything larger makes `new Date(ts).toISOString()` throw downstream, which can
 * wedge the spool tailer on a single poisoned line.
 */
const MAX_TIMESTAMP_MS = 8640000000000000;
function inRange(value, min, max) {
    return value >= min && value <= max;
}
/** ISO timestamp parseable into the same bounded Date range enforced for `ts`. */
function isBoundedIsoTimestamp(value) {
    if (!isNonEmptyString(value)) {
        return false;
    }
    const ms = Date.parse(value);
    return Number.isFinite(ms) && inRange(ms, 0, MAX_TIMESTAMP_MS);
}
function validateAiSession(input, path) {
    if (!isRecord(input)) {
        return failure([`${path} must be an object`]);
    }
    const errors = [];
    for (const key of ['id', 'scannerId', 'tool', 'startedAt']) {
        if (!isNonEmptyString(input[key])) {
            errors.push(`${path}.${key} must be a non-empty string`);
        }
    }
    if (!isFiniteNumber(input.confidence) || !inRange(input.confidence, 0, 1)) {
        errors.push(`${path}.confidence must be a number between 0 and 1`);
    }
    if (input.source !== undefined &&
        !AI_SESSION_SOURCES.includes(input.source)) {
        errors.push(`${path}.source must be one of: ${AI_SESSION_SOURCES.join(', ')} when present`);
    }
    if (input.lastActivityAt !== undefined && !isBoundedIsoTimestamp(input.lastActivityAt)) {
        errors.push(`${path}.lastActivityAt must be a valid ISO-8601 timestamp when present`);
    }
    for (const key of ['activeDuration', 'runDuration']) {
        const value = input[key];
        if (value !== undefined && (!isFiniteNumber(value) || value < 0)) {
            errors.push(`${path}.${key} must be a non-negative number when present`);
        }
    }
    if (errors.length > 0) {
        return failure(errors);
    }
    return success({
        id: input.id,
        sessionId: input.sessionId,
        scannerId: input.scannerId,
        tool: input.tool,
        model: input.model,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        confidence: input.confidence,
        source: input.source,
        lastActivityAt: input.lastActivityAt,
        activeDuration: input.activeDuration,
        runDuration: input.runDuration,
    });
}
function validateEvidence(input, path = 'evidence') {
    if (!isRecord(input)) {
        return failure([`${path} must be an object`]);
    }
    const errors = [];
    if (!EVIDENCE_TYPES.includes(input.type)) {
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
        type: input.type,
        timestamp: input.timestamp,
        hash: input.hash,
    });
}
function validateTokenUsage(input, path = 'usage') {
    if (!isRecord(input)) {
        return failure([`${path} must be an object`]);
    }
    const errors = [];
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
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheWriteTokens: input.cacheWriteTokens,
        reasoningTokens: input.reasoningTokens,
        totalTokens: input.totalTokens,
        model: input.model,
        currency: input.currency,
        estimatedCost: input.estimatedCost,
        isEstimated: input.isEstimated,
        aiSessionId: input.aiSessionId,
        scannerId: input.scannerId,
        tool: input.tool,
    });
}
function validateFileChangeMeta(input, path = 'change') {
    if (!isRecord(input)) {
        return failure([`${path} must be an object`]);
    }
    const errors = [];
    if (!isNonEmptyString(input.pathHash)) {
        errors.push(`${path}.pathHash must be a non-empty string`);
    }
    if (input.repoRootHash !== undefined && !isNonEmptyString(input.repoRootHash)) {
        errors.push(`${path}.repoRootHash must be a non-empty string when present`);
    }
    if (!FILE_CHANGE_TYPES.includes(input.changeType)) {
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
        pathHash: input.pathHash,
        repoRootHash: input.repoRootHash,
        changeType: input.changeType,
        linesAdded: input.linesAdded,
        linesRemoved: input.linesRemoved,
        language: input.language,
        aiAttributed: input.aiAttributed,
        aiSessionId: input.aiSessionId,
    });
}
function validateCodingSession(input, path) {
    if (!isRecord(input)) {
        return failure([`${path} must be an object`]);
    }
    const errors = [];
    const requiredStrings = [
        'id',
        'startTime',
        'project',
        'language',
        'file',
    ];
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
    for (const counter of ['heartbeats', 'keystrokes', 'linesAdded', 'linesRemoved']) {
        if (!isFiniteNumber(input[counter]) || input[counter] < 0) {
            errors.push(`${path}.${counter} must be a non-negative number`);
        }
    }
    if (errors.length > 0) {
        return failure(errors);
    }
    return success({
        id: input.id,
        startTime: input.startTime,
        endTime: input.endTime,
        duration: input.duration,
        idleDuration: input.idleDuration,
        project: input.project,
        language: input.language,
        file: input.file,
        branch: input.branch,
        isActive: input.isActive,
        heartbeats: input.heartbeats,
        keystrokes: input.keystrokes,
        linesAdded: input.linesAdded,
        linesRemoved: input.linesRemoved,
        productivityScore: input.productivityScore,
        tags: input.tags,
        aiAssisted: input.aiAssisted,
    });
}
function validateFileSnapshotMeta(input, path) {
    if (!isRecord(input)) {
        return failure([`${path} must be an object`]);
    }
    const errors = [];
    for (const key of ['id', 'project', 'pathHash', 'createdAt']) {
        if (!isNonEmptyString(input[key])) {
            errors.push(`${path}.${key} must be a non-empty string`);
        }
    }
    if (!SNAPSHOT_TYPES.includes(input.snapshotType)) {
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
        id: input.id,
        aiSessionId: input.aiSessionId,
        sessionId: input.sessionId,
        project: input.project,
        pathHash: input.pathHash,
        snapshotType: input.snapshotType,
        diffPath: input.diffPath,
        fileHashBefore: input.fileHashBefore,
        fileHashAfter: input.fileHashAfter,
        sizeBytes: input.sizeBytes,
        createdAt: input.createdAt,
    });
}
function validateRecoveryAction(input, path) {
    if (!isRecord(input)) {
        return failure([`${path} must be an object`]);
    }
    const errors = [];
    const required = ['id', 'snapshotId', 'action', 'correlationId', 'occurredAt'];
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
        id: input.id,
        aiSessionId: input.aiSessionId,
        snapshotId: input.snapshotId,
        action: input.action,
        correlationId: input.correlationId,
        filesAffected: input.filesAffected,
        occurredAt: input.occurredAt,
        dryRun: input.dryRun,
        error: input.error,
    });
}
function validateClientInfo(input, path) {
    if (!isRecord(input)) {
        return failure([`${path} must be an object`]);
    }
    const errors = [];
    if (!isNonEmptyString(input.id)) {
        errors.push(`${path}.id must be a non-empty string`);
    }
    if (!['vscode', 'desktop', 'cli'].includes(input.kind)) {
        errors.push(`${path}.kind must be vscode, desktop, or cli`);
    }
    if (!isNonEmptyString(input.connectedAt)) {
        errors.push(`${path}.connectedAt must be a non-empty string`);
    }
    if (errors.length > 0) {
        return failure(errors);
    }
    return success({
        id: input.id,
        kind: input.kind,
        version: input.version,
        connectedAt: input.connectedAt,
    });
}
function validateScannerManifestSummary(input, path) {
    if (!isRecord(input)) {
        return failure([`${path} must be an object`]);
    }
    const errors = [];
    for (const key of ['id', 'version', 'displayName']) {
        if (!isNonEmptyString(input[key])) {
            errors.push(`${path}.${key} must be a non-empty string`);
        }
    }
    if (!TRUST_TIERS.includes(input.trust)) {
        errors.push(`${path}.trust must be one of: ${TRUST_TIERS.join(', ')}`);
    }
    if (typeof input.enabled !== 'boolean') {
        errors.push(`${path}.enabled must be a boolean`);
    }
    if (errors.length > 0) {
        return failure(errors);
    }
    return success({
        id: input.id,
        version: input.version,
        displayName: input.displayName,
        trust: input.trust,
        enabled: input.enabled,
        lastScanAt: input.lastScanAt,
        evidenceCount: input.evidenceCount,
    });
}
function validateDaemonEvent(input, path = 'payload') {
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
            const errors = [];
            if (!isNonEmptyString(input.tool)) {
                errors.push(`${path}.tool must be a non-empty string`);
            }
            if (!isFiniteNumber(input.confidence) || !inRange(input.confidence, 0, 1)) {
                errors.push(`${path}.confidence must be a number between 0 and 1`);
            }
            if (!Array.isArray(input.evidence)) {
                errors.push(`${path}.evidence must be an array`);
            }
            else {
                const evidence = [];
                for (let i = 0; i < input.evidence.length; i++) {
                    const item = validateEvidence(input.evidence[i], `${path}.evidence[${i}]`);
                    if (!item.ok) {
                        errors.push(...item.errors);
                    }
                    else {
                        evidence.push(item.value);
                    }
                }
                if (errors.length === 0) {
                    return success({
                        type: 'ai.tool.detected',
                        tool: input.tool,
                        confidence: input.confidence,
                        evidence,
                        scannerId: input.scannerId,
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
            const scanners = [];
            const errors = [];
            for (let i = 0; i < input.scanners.length; i++) {
                const item = validateScannerManifestSummary(input.scanners[i], `${path}.scanners[${i}]`);
                if (!item.ok) {
                    errors.push(...item.errors);
                }
                else {
                    scanners.push(item.value);
                }
            }
            if (errors.length > 0) {
                return failure(errors);
            }
            return success({ type: 'registry.updated', scanners });
        }
        case 'scanner.quarantined': {
            const errors = [];
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
                scannerId: input.scannerId,
                reason: input.reason,
                version: input.version,
                errorRate: input.errorRate,
                threshold: input.threshold,
                eventsDropped: input.eventsDropped,
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
function validateEnvelope(input) {
    if (!isRecord(input)) {
        return failure(['envelope must be an object']);
    }
    const errors = [];
    if (input.v !== envelope_1.ENVELOPE_VERSION) {
        errors.push(`envelope.v must be ${envelope_1.ENVELOPE_VERSION}`);
    }
    if (!isNonEmptyString(input.id)) {
        errors.push('envelope.id must be a non-empty string');
    }
    if (!isFiniteNumber(input.ts) || input.ts < 0 || input.ts > MAX_TIMESTAMP_MS) {
        errors.push(`envelope.ts must be a number between 0 and ${MAX_TIMESTAMP_MS}`);
    }
    if (!ENVELOPE_SOURCES.includes(input.src)) {
        errors.push(`envelope.src must be one of: ${ENVELOPE_SOURCES.join(', ')}`);
    }
    if (input.corr !== undefined && !isNonEmptyString(input.corr)) {
        errors.push('envelope.corr must be a non-empty string when present');
    }
    const payload = validateDaemonEvent(input.payload, 'payload');
    if (!payload.ok) {
        errors.push(...payload.errors);
    }
    else if (input.type !== payload.value.type) {
        errors.push('envelope.type must match payload.type');
    }
    if (errors.length > 0 || !payload.ok) {
        return failure(errors);
    }
    return success({
        v: envelope_1.ENVELOPE_VERSION,
        id: input.id,
        ts: input.ts,
        src: input.src,
        corr: input.corr,
        type: payload.value.type,
        payload: payload.value,
    });
}
/** Reject frames larger than the daemon ingest limit. */
function validateFrameSize(byteLength) {
    if (!Number.isFinite(byteLength) || byteLength < 0) {
        return failure(['byteLength must be a non-negative finite number']);
    }
    if (byteLength > envelope_1.MAX_FRAME_BYTES) {
        return failure([`frame exceeds maximum size of ${envelope_1.MAX_FRAME_BYTES} bytes`]);
    }
    return success(byteLength);
}
function validateScannerManifest(input) {
    if (!isRecord(input)) {
        return failure(['manifest must be an object']);
    }
    const errors = [];
    if (input.$schema !== undefined &&
        input.$schema !== scanner_manifest_1.SCANNER_MANIFEST_SCHEMA_URL) {
        errors.push(`$schema must be ${scanner_manifest_1.SCANNER_MANIFEST_SCHEMA_URL} when present`);
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
    ]) {
        if (!isNonEmptyString(input[key])) {
            errors.push(`manifest.${key} must be a non-empty string`);
        }
    }
    if (!TRUST_TIERS.includes(input.trust)) {
        errors.push(`manifest.trust must be one of: ${TRUST_TIERS.join(', ')}`);
    }
    if (!CONTENT_POLICIES.includes(input.contentPolicy)) {
        errors.push(`manifest.contentPolicy must be one of: ${CONTENT_POLICIES.join(', ')}`);
    }
    if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
        errors.push('manifest.capabilities must be a non-empty array');
    }
    else {
        for (const capability of input.capabilities) {
            if (!SCANNER_CAPABILITIES.includes(capability)) {
                errors.push(`manifest.capabilities contains invalid value: ${String(capability)}`);
            }
        }
    }
    if (input.processPatterns !== undefined && !isStringArray(input.processPatterns)) {
        errors.push('manifest.processPatterns must be a string array when present');
    }
    if (input.logPaths !== undefined) {
        if (!Array.isArray(input.logPaths)) {
            errors.push('manifest.logPaths must be an array when present');
        }
        else {
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
                if (!['tail', 'poll', 'once'].includes(entry.watchMode)) {
                    errors.push(`manifest.logPaths[${i}].watchMode must be tail, poll, or once`);
                }
            }
        }
    }
    if (input.hookInstaller !== undefined) {
        const hook = input.hookInstaller;
        if (!isRecord(hook)) {
            errors.push('manifest.hookInstaller must be an object when present');
        }
        else {
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
        }
        else {
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
        $schema: input.$schema,
        id: input.id,
        version: input.version,
        displayName: input.displayName,
        publisher: input.publisher,
        trust: input.trust,
        minDaemon: input.minDaemon,
        minProtocol: input.minProtocol,
        capabilities: input.capabilities,
        processPatterns: input.processPatterns,
        logPaths: input.logPaths,
        hookInstaller: input.hookInstaller,
        tokenFields: input.tokenFields,
        fileChangeTools: input.fileChangeTools,
        allowedFields: input.allowedFields,
        redactedFields: input.redactedFields,
        contentPolicy: input.contentPolicy,
        signature: input.signature,
        bundleHash: input.bundleHash,
    });
}
//# sourceMappingURL=validate.js.map