"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScannerEngine = void 0;
const events_1 = require("events");
const registry_1 = require("@codepulse/registry");
const envelope_1 = require("../envelope");
const log_tailer_1 = require("./log-tailer");
const process_watcher_1 = require("./process-watcher");
class ScannerEngine extends events_1.EventEmitter {
    deps;
    registry;
    registryHost;
    processWatcher;
    logTailer;
    manifests = [];
    quarantined = new Set();
    started = false;
    ingestChain = Promise.resolve();
    constructor(deps) {
        super();
        this.deps = deps;
        this.registry = new registry_1.LocalRegistry(deps.registryDir);
        this.registryHost = new registry_1.RegistryHost(this.registry);
        const isEnabled = (manifest) => this.isScannerEnabled(manifest);
        this.processWatcher = new process_watcher_1.ProcessWatcher({
            registryHost: this.registryHost,
            metrics: deps.metrics,
            isEnabled
        }, { pollIntervalMs: 5000 });
        this.logTailer = new log_tailer_1.LogTailer({
            registryHost: this.registryHost,
            database: deps.database,
            metrics: deps.metrics,
            isEnabled
        }, { pollIntervalMs: 3000 });
        this.processWatcher.on('detected', detection => {
            this.enqueueIngest(() => this.handleProcessDetection(detection));
        });
        this.processWatcher.on('session-started', event => {
            this.enqueueIngest(() => this.handleProcessSessionStarted(event));
        });
        this.processWatcher.on('session-ended', event => {
            this.enqueueIngest(() => this.handleProcessSessionEnded(event));
        });
        this.logTailer.on('batch', batch => {
            this.enqueueIngest(() => this.handleParsedLogBatch(batch));
        });
        this.processWatcher.on('error', error => this.emit('error', error));
        this.logTailer.on('error', error => this.emit('error', error));
    }
    async start() {
        if (this.started) {
            return;
        }
        this.manifests = await this.registry.load();
        await this.syncRegistryRows();
        await this.logTailer.start(this.manifests);
        void this.processWatcher.start(this.manifests).catch(error => this.emit('error', error));
        this.started = true;
        this.emit('started', { scannerCount: this.manifests.length });
    }
    async stop() {
        await this.processWatcher.stop();
        await this.logTailer.stop();
        this.started = false;
    }
    getManifests() {
        return [...this.manifests];
    }
    isScannerEnabled(manifest) {
        if (this.quarantined.has(manifest.id)) {
            return false;
        }
        if (manifest.enabled === false) {
            return false;
        }
        if (manifest.enabled === true) {
            return true;
        }
        return manifest.trust === 'official' || manifest.trust === 'verified';
    }
    async syncRegistryRows() {
        const now = new Date().toISOString();
        for (const manifest of this.manifests) {
            const signature = (0, registry_1.verifyManifestSignature)(manifest);
            if (!signature.ok) {
                this.quarantined.add(manifest.id);
                this.deps.metrics.increment('codepulse_scanner_quarantined_total');
                this.deps.broadcast((0, envelope_1.createDaemonEnvelope)({
                    type: 'scanner.quarantined',
                    scannerId: manifest.id,
                    reason: signature.reason ?? 'signature verification failed',
                    version: manifest.version
                }));
                continue;
            }
            await this.deps.database.upsertRegistryScanner({
                id: manifest.id,
                version: manifest.version,
                trust: manifest.trust,
                enabled: this.isScannerEnabled(manifest) ? 1 : 0,
                installed_at: now,
                last_scan_at: null,
                manifest_hash: this.registry.manifestHash(manifest.id) ?? ''
            });
        }
    }
    async handleProcessDetection(detection) {
        const envelope = (0, envelope_1.createDaemonEnvelope)({
            type: 'ai.tool.detected',
            tool: detection.result.tool,
            confidence: detection.result.confidence,
            evidence: detection.result.evidence.map(item => ({
                type: item.type,
                timestamp: item.timestamp,
                hash: item.hash
            })),
            scannerId: detection.scannerId
        });
        await this.publishEnvelope(envelope, 'scanner');
        await this.deps.database.touchRegistryScannerLastScan(detection.scannerId, new Date().toISOString());
    }
    /**
     * Process appeared — open an AI session (source 'process') through the
     * shared publish path so DB ingest and WS broadcast stay in lockstep.
     * When another source (log/hook) already holds the open (scanner, tool)
     * session, the ingest dedups and nothing is broadcast.
     */
    async handleProcessSessionStarted(event) {
        const envelope = (0, envelope_1.createDaemonEnvelope)({
            type: 'ai.session.started',
            aiSession: {
                id: event.sessionId,
                scannerId: event.scannerId,
                tool: event.tool,
                startedAt: event.startedAt,
                confidence: event.confidence,
                source: 'process'
            }
        });
        const ingested = await this.publishEnvelope(envelope, 'scanner');
        if (ingested) {
            this.deps.metrics.increment('codepulse_scanner_sessions_started_total');
        }
    }
    /**
     * Process gone past the grace window — close the open (scanner, tool)
     * session. The watcher's tracked id may not be the open row's id (its
     * started envelope dedups when log/hook opened the session first), so
     * resolve the actual open row; falling back to the tracked id keeps the
     * end a harmless no-op when nothing is open.
     */
    async handleProcessSessionEnded(event) {
        const open = await this.findOpenAiSession(event.scannerId, event.tool);
        const envelope = (0, envelope_1.createDaemonEnvelope)({
            type: 'ai.session.ended',
            aiSession: {
                id: open?.id ?? event.sessionId,
                scannerId: event.scannerId,
                tool: event.tool,
                startedAt: open?.started_at ?? event.startedAt,
                endedAt: event.endedAt ?? new Date().toISOString(),
                confidence: event.confidence,
                source: 'process'
            }
        });
        const ingested = await this.publishEnvelope(envelope, 'scanner');
        if (ingested) {
            this.deps.metrics.increment('codepulse_scanner_sessions_ended_total');
        }
    }
    async findOpenAiSession(scannerId, tool) {
        const sessions = await this.deps.database.listAiSessions(1000);
        return (sessions.find(row => row.scanner_id === scannerId && row.tool === tool && row.ended_at === null) ?? null);
    }
    /**
     * Ingests the batch's envelopes and the cursor upsert in one DB
     * transaction so a slow batch can never persist the cursor ahead of (or
     * behind) its events — replays after a crash dedup via deterministic
     * envelope ids.
     */
    async handleParsedLogBatch(batch) {
        // A batch queued behind a failing ingest (or in flight during it)
        // was read under tail state that resetState has since invalidated —
        // committing its cursor would advance PAST the failed batch's
        // rolled-back lines, losing them forever. Drop it; the post-reset
        // poll re-reads everything from the persisted cursor and dedups via
        // deterministic envelope ids.
        if (!this.logTailer.isCurrentGeneration(batch)) {
            return;
        }
        const envelopes = [];
        for (const event of batch.events) {
            envelopes.push(...this.buildLogEventEnvelopes(batch, event));
        }
        let ingested;
        try {
            ingested = await this.deps.database.ingestLogBatchWithCursor(envelopes, batch.cursor);
        }
        catch (error) {
            // The tailer's in-memory offset already advanced past this
            // batch's lines, so a failed (rolled-back) ingest would
            // otherwise drop them forever — invalidate the in-memory state
            // so the next poll resumes from the last persisted cursor; the
            // replayed prefix dedups via deterministic envelope ids.
            this.logTailer.resetState(batch.manifest.id, batch.filePath);
            throw error;
        }
        for (const envelope of ingested) {
            this.deps.broadcast(envelope);
            if (envelope.payload.type === 'ai.session.started') {
                this.deps.metrics.increment('codepulse_scanner_sessions_started_total');
            }
            else if (envelope.payload.type === 'ai.session.ended') {
                this.deps.metrics.increment('codepulse_scanner_sessions_ended_total');
            }
        }
    }
    buildLogEventEnvelopes(batch, event) {
        const manifest = batch.manifest;
        const envelopes = [];
        // Deterministic per physical line: the same (scanner, file, offset,
        // line) always yields the same envelope id, so re-parses dedup in
        // SQLite. The byte offset discriminates byte-identical lines at
        // different positions in the same file — content alone would collide
        // and INSERT OR IGNORE would silently swallow the second's tokens.
        const idFor = (envelopeType) => (0, envelope_1.deriveEnvelopeId)(manifest.id, batch.filePath, String(event.byteOffset), event.lineHash, envelopeType);
        const isStart = Boolean(event.sessionId) && isSessionStartEvent(event.eventType);
        // session.started must precede ai.tokens: the tokens ingest would
        // otherwise create the ai_session row first and the started envelope
        // would dedup away (and never broadcast).
        if (isStart && event.sessionId) {
            envelopes.push((0, envelope_1.createDaemonEnvelope)({
                type: 'ai.session.started',
                aiSession: {
                    id: event.sessionId,
                    scannerId: manifest.id,
                    tool: manifest.displayName,
                    model: event.tokens?.model,
                    startedAt: event.timestamp,
                    source: 'log',
                    confidence: 0.9
                }
            }, undefined, idFor('ai.session.started')));
        }
        if (event.tokens) {
            const usage = event.tokens;
            envelopes.push({
                ...(0, envelope_1.createDaemonEnvelope)({
                    type: 'ai.tokens',
                    usage: {
                        inputTokens: usage.inputTokens ?? 0,
                        outputTokens: usage.outputTokens ?? 0,
                        cacheReadTokens: usage.cacheReadTokens,
                        cacheWriteTokens: usage.cacheWriteTokens,
                        reasoningTokens: usage.reasoningTokens,
                        totalTokens: usage.totalTokens ??
                            (usage.inputTokens ?? 0) +
                                (usage.outputTokens ?? 0) +
                                (usage.cacheReadTokens ?? 0) +
                                (usage.cacheWriteTokens ?? 0),
                        model: usage.model,
                        isEstimated: usage.isEstimated,
                        aiSessionId: event.sessionId,
                        scannerId: manifest.id,
                        tool: manifest.displayName
                    }
                }, undefined, idFor('ai.tokens')),
                src: 'scanner'
            });
        }
        if (!isStart && event.sessionId && isSessionEndEvent(event.eventType)) {
            envelopes.push((0, envelope_1.createDaemonEnvelope)({
                type: 'ai.session.ended',
                aiSession: {
                    id: event.sessionId,
                    scannerId: manifest.id,
                    tool: manifest.displayName,
                    model: event.tokens?.model,
                    startedAt: event.timestamp,
                    endedAt: event.timestamp,
                    source: 'log',
                    confidence: 0.9
                }
            }, undefined, idFor('ai.session.ended')));
        }
        return envelopes;
    }
    enqueueIngest(task) {
        this.ingestChain = this.ingestChain
            .then(task)
            .catch(error => {
            this.emit('error', error instanceof Error ? error : new Error(String(error)));
        });
    }
    /** Ingest-then-broadcast; returns whether the envelope was newly ingested. */
    async publishEnvelope(envelope, source) {
        const framed = { ...envelope, src: source };
        const ingested = await this.deps.database.ingestEnvelopeFromSpool(framed);
        if (ingested) {
            this.deps.broadcast(framed);
        }
        return ingested;
    }
}
exports.ScannerEngine = ScannerEngine;
function isSessionStartEvent(eventType) {
    if (!eventType) {
        return false;
    }
    const normalized = eventType.toLowerCase();
    return (normalized === 'session_start' ||
        normalized.endsWith('_start') ||
        normalized.includes('session_start'));
}
function isSessionEndEvent(eventType) {
    if (!eventType) {
        return false;
    }
    const normalized = eventType.toLowerCase();
    return (normalized === 'session_end' ||
        normalized === 'session_stop' ||
        normalized === 'stop' ||
        normalized.endsWith('_end') ||
        normalized.endsWith('_stop') ||
        normalized.includes('session_end'));
}
//# sourceMappingURL=engine.js.map