import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { RegistryHost, ScannerManifest, ScanResult } from '@codepulse/registry';
import type { MetricsRegistry } from '../metrics';
import { listProcessEntries, type ProcessEntry } from './processes';

/**
 * Re-emit window per (scanner, tool): must exceed the poll interval, or
 * `ai.tool.detected` re-fires on every poll while the process is running.
 */
const DETECTION_DEBOUNCE_MS = 60_000;

/**
 * A tool must be absent for this many CONSECUTIVE polls before its process
 * session ends (~10s grace at the 5s poll) — a single missed `ps` snapshot
 * (exec hiccup, brief restart) must not split one run into two sessions.
 */
const PRESENCE_GRACE_POLLS = 2;

export interface ProcessWatcherOptions {
    pollIntervalMs?: number;
    confidenceThreshold?: number;
    detectionDebounceMs?: number;
    presenceGracePolls?: number;
}

export interface ProcessWatcherDeps {
    registryHost: RegistryHost;
    metrics: MetricsRegistry;
    isEnabled: (manifest: ScannerManifest) => boolean;
    /** Injectable for tests — defaults to the real `ps` capture. */
    listProcesses?: () => Promise<ProcessEntry[]>;
}

export interface ProcessDetection {
    scannerId: string;
    manifest: ScannerManifest;
    result: ScanResult;
}

/** Presence lifecycle event for one (scanner, tool) process session. */
export interface ProcessSessionEvent {
    scannerId: string;
    manifest: ScannerManifest;
    tool: string;
    /** Watcher-minted session id — the DB may dedup onto an existing open row. */
    sessionId: string;
    /** ISO run start, backdated via etime of the matched processes. */
    startedAt: string;
    confidence: number;
    /** Only set on 'session-ended' events. */
    endedAt?: string;
}

interface PresenceState {
    scannerId: string;
    manifest: ScannerManifest;
    tool: string;
    sessionId: string;
    startedAt: string;
    confidence: number;
    /** Consecutive polls the tool has been absent. */
    missedPolls: number;
}

export class ProcessWatcher extends EventEmitter {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private isPolling = false;
    private lastDetections = new Map<string, number>();
    private presence = new Map<string, PresenceState>();
    private readonly pollIntervalMs: number;
    private readonly confidenceThreshold: number;
    private readonly detectionDebounceMs: number;
    private readonly presenceGracePolls: number;
    private readonly listProcesses: () => Promise<ProcessEntry[]>;

    constructor(
        private readonly deps: ProcessWatcherDeps,
        options: ProcessWatcherOptions = {}
    ) {
        super();
        this.pollIntervalMs = options.pollIntervalMs ?? 5000;
        this.confidenceThreshold = options.confidenceThreshold ?? 0.35;
        this.detectionDebounceMs = options.detectionDebounceMs ?? DETECTION_DEBOUNCE_MS;
        this.presenceGracePolls = options.presenceGracePolls ?? PRESENCE_GRACE_POLLS;
        this.listProcesses = deps.listProcesses ?? listProcessEntries;
    }

    async start(manifests: ScannerManifest[]): Promise<void> {
        if (this.running) {
            return;
        }
        this.running = true;
        // Install the interval BEFORE the first poll (mirrors LogTailer): a
        // transient ps/tasklist failure on the initial poll must not leave
        // running=true with no timer, disabling process detection for the
        // daemon's lifetime.
        setImmediate(() => {
            void this.poll(manifests).catch(error => this.emit('error', error));
        });
        this.timer = setInterval(() => {
            void this.poll(manifests).catch(error => {
                this.emit('error', error);
            });
        }, this.pollIntervalMs);
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async poll(manifests: ScannerManifest[]): Promise<void> {
        if (this.isPolling) {
            return;
        }
        this.isPolling = true;
        try {
            await this.pollOnce(manifests);
        } finally {
            this.isPolling = false;
        }
    }

    private async pollOnce(manifests: ScannerManifest[]): Promise<void> {
        const entries = await this.listProcesses();
        const processes = entries.map(entry => entry.comm);
        const timestamp = new Date().toISOString();
        const now = Date.now();

        // Keys seen this poll and scanners actually polled — a disabled or
        // process-less scanner is "not observed", never "absent", so its open
        // session must not be ended by this pass.
        const presentKeys = new Set<string>();
        const polledScannerIds = new Set<string>();

        for (const manifest of manifests) {
            if (!this.deps.isEnabled(manifest)) {
                continue;
            }
            if (!manifest.capabilities.includes('process')) {
                continue;
            }
            polledScannerIds.add(manifest.id);

            const result = await this.deps.registryHost.scan(manifest.id, {
                processes,
                timestamp
            });

            if (result.confidence < this.confidenceThreshold) {
                continue;
            }

            const presenceKey = `${manifest.id}:${result.tool}`;
            presentKeys.add(presenceKey);
            this.observePresence(presenceKey, manifest, result, entries, now, timestamp);

            const debounceKey = presenceKey;
            const lastSeen = this.lastDetections.get(debounceKey) ?? 0;
            if (now - lastSeen < this.detectionDebounceMs) {
                continue;
            }

            this.lastDetections.set(debounceKey, now);
            this.deps.metrics.increment('codepulse_scanner_process_detected_total');

            const detection: ProcessDetection = {
                scannerId: manifest.id,
                manifest,
                result
            };
            this.emit('detected', detection);
        }

        this.sweepAbsent(presentKeys, polledScannerIds, timestamp);
    }

    /**
     * Marks a (scanner, tool) present: resets the absence counter for known
     * sessions, or opens a new presence session — backdated to the matched
     * processes' earliest start via etime — and emits 'session-started'.
     */
    private observePresence(
        presenceKey: string,
        manifest: ScannerManifest,
        result: ScanResult,
        entries: ProcessEntry[],
        nowMs: number,
        timestamp: string
    ): void {
        const existing = this.presence.get(presenceKey);
        if (existing) {
            this.presence.set(presenceKey, { ...existing, missedPolls: 0 });
            return;
        }

        const state: PresenceState = {
            scannerId: manifest.id,
            manifest,
            tool: result.tool,
            sessionId: randomUUID(),
            startedAt: earliestProcessStart(manifest, entries, nowMs) ?? timestamp,
            confidence: result.confidence,
            missedPolls: 0
        };
        this.presence.set(presenceKey, state);
        this.deps.metrics.increment('codepulse_scanner_process_sessions_started_total');
        this.emit('session-started', toSessionEvent(state));
    }

    /**
     * Advances absence counters for tracked sessions whose scanner WAS polled
     * but whose tool was not seen; after `presenceGracePolls` consecutive
     * misses the session ends. A reappearance within the grace window resets
     * the counter in observePresence, so flaps never split sessions.
     */
    private sweepAbsent(
        presentKeys: Set<string>,
        polledScannerIds: Set<string>,
        timestamp: string
    ): void {
        for (const [key, state] of [...this.presence.entries()]) {
            if (presentKeys.has(key) || !polledScannerIds.has(state.scannerId)) {
                continue;
            }

            const missedPolls = state.missedPolls + 1;
            if (missedPolls < this.presenceGracePolls) {
                this.presence.set(key, { ...state, missedPolls });
                continue;
            }

            this.presence.delete(key);
            this.deps.metrics.increment('codepulse_scanner_process_sessions_ended_total');
            this.emit('session-ended', { ...toSessionEvent(state), endedAt: timestamp });
        }
    }
}

/**
 * Earliest run start among processes matching the manifest's processPatterns
 * (case-insensitive substring, mirroring the registry's manifest scanner) —
 * `now - max(etime)`. Null when nothing matches (e.g. patternless manifests).
 */
function earliestProcessStart(
    manifest: ScannerManifest,
    entries: ProcessEntry[],
    nowMs: number
): string | null {
    const patterns = (manifest.processPatterns ?? []).map(pattern => pattern.toLowerCase());
    if (patterns.length === 0) {
        return null;
    }

    const matchedEtimes = entries
        .filter(entry => {
            const comm = entry.comm.toLowerCase();
            return patterns.some(pattern => comm.includes(pattern));
        })
        .map(entry => entry.etimeSeconds);

    if (matchedEtimes.length === 0) {
        return null;
    }
    return new Date(nowMs - Math.max(...matchedEtimes) * 1000).toISOString();
}

function toSessionEvent(state: PresenceState): ProcessSessionEvent {
    return {
        scannerId: state.scannerId,
        manifest: state.manifest,
        tool: state.tool,
        sessionId: state.sessionId,
        startedAt: state.startedAt,
        confidence: state.confidence
    };
}
