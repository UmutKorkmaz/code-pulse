import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { DaemonEnvelope } from '../client/DaemonClient';
import { Logger } from '../utils/Logger';

/**
 * Narrow forwarding surface of DaemonClient used by the AI detectors.
 * DaemonClient satisfies this structurally; tests inject a recording stub.
 */
export interface AiDetectionForwarder {
    isDaemonMode(): boolean;
    ingest(events: DaemonEnvelope[]): Promise<void>;
}

/**
 * Canonical identity of an AI CLI, mirroring its registry-catalog manifest:
 * `scannerId` is the manifest `id` and `tool` is the manifest `displayName` —
 * exactly what the daemon's process/log scanners emit (manifestScanner sets
 * ScanResult.tool = displayName). Forwarding the same pair makes the daemon
 * merge terminal detections into the existing (scanner, tool) session instead
 * of opening a duplicate that double-counts time in the unified panel.
 */
export interface CanonicalAiCliTool {
    /** Lowercase executable basename of the CLI (case-insensitive match). */
    cli: string;
    /** Registry-catalog manifest id (platform/registry-catalog/<id>.json). */
    scannerId: string;
    /** Manifest displayName — the canonical tool name across all sources. */
    tool: string;
}

/** Known AI CLIs, basename → canonical (scannerId, tool) per registry-catalog. */
export const AI_CLI_TOOLS: readonly CanonicalAiCliTool[] = [
    { cli: 'claude', scannerId: 'scn.claude-code', tool: 'Claude Code' },
    { cli: 'codex', scannerId: 'scn.openai-codex', tool: 'OpenAI Codex' },
    { cli: 'droid', scannerId: 'scn.factory-droid', tool: 'Droid (Factory)' },
    { cli: 'cline', scannerId: 'scn.cline', tool: 'Cline' },
    { cli: 'kilo', scannerId: 'scn.kilo', tool: 'Kilo' },
    { cli: 'cursor-agent', scannerId: 'scn.cursor-ide', tool: 'Cursor' }
];

/** One `ps` snapshot per poll (design default: 10s). */
export const TERMINAL_SCAN_INTERVAL_MS = 10_000;

/**
 * Re-forward window per tool, mirroring the daemon ProcessWatcher's
 * DETECTION_DEBOUNCE_MS: a 10s presence poll must not re-emit
 * `ai.tool.detected` on every poll while a tool simply keeps running.
 */
export const TERMINAL_DETECTION_DEBOUNCE_MS = 60_000;

/** A tool stays "running in terminal" until it has missed this many polls (design default). */
export const TERMINAL_RUNNING_GRACE_POLLS = 2;

/** Detection-strategy §4.5 confidence weight for terminal-sourced evidence. */
export const TERMINAL_DETECTION_CONFIDENCE = 0.1;

const PS_TIMEOUT_MS = 5_000;
const PS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_DESCENDANTS_PER_TERMINAL = 512;

export interface TerminalAiToolState {
    tool: string;
    /** Milliseconds since epoch of the poll that last saw the tool. */
    lastSeenAt: number;
}

export interface TerminalAiDetectorOptions {
    intervalMs?: number;
    /** Per-tool re-forward window (default TERMINAL_DETECTION_DEBOUNCE_MS). */
    detectionDebounceMs?: number;
    listTerminals?: () => readonly vscode.Terminal[];
    onDidOpenTerminal?: vscode.Event<vscode.Terminal>;
    onDidCloseTerminal?: vscode.Event<vscode.Terminal>;
    /** Override for the `ps` snapshot — tests inject fixture output here. */
    runPs?: () => Promise<string>;
}

interface ProcessEntry {
    pid: number;
    ppid: number;
    command: string;
}

/** One matched CLI in a poll: canonical identity plus a representative pid. */
interface AiToolDetection {
    match: CanonicalAiCliTool;
    pid: number;
}

/**
 * Builds an `ai.tool.detected` envelope per the daemon protocol contract
 * (protocol/src/envelope.ts DaemonEvent). Shared by the terminal and
 * extension detectors so both evidence paths stay wire-identical. When
 * `scannerId` is provided the daemon merges the detection into the open
 * (scannerId, tool) session; without it the daemon keys on envelope.src.
 */
export function buildAiToolDetectedEnvelope(
    tool: string,
    evidenceType: 'terminal' | 'extension_report',
    confidence: number,
    hashSeed: string,
    scannerId?: string
): DaemonEnvelope {
    return {
        v: 1,
        id: uuidv4(),
        ts: Date.now(),
        src: 'vscode',
        type: 'ai.tool.detected',
        payload: {
            type: 'ai.tool.detected',
            tool,
            confidence,
            ...(scannerId ? { scannerId } : {}),
            evidence: [
                {
                    type: evidenceType,
                    timestamp: new Date().toISOString(),
                    // Content hash for dedup per the protocol Evidence contract — never raw content.
                    hash: crypto.createHash('sha256').update(hashSeed).digest('hex')
                }
            ]
        }
    };
}

/**
 * Detects AI CLIs (claude, codex, droid, cline, kilo, cursor-agent) running
 * inside VS Code terminals. Mirrors the HeartbeatManager interval+disposable
 * pattern: one `ps -ax` snapshot per 10s poll, descendant walk from each
 * terminal's processId, plus immediate rescans on terminal open/close.
 *
 * Detections are forwarded as `ai.tool.detected` envelopes (evidence type
 * 'terminal', src 'vscode', canonical registry-catalog scannerId + tool)
 * while the daemon is reachable, debounced per tool so a steady-state poll
 * does not re-emit; a local tool → lastSeen map (refreshed every poll
 * regardless of forwarding) keeps the dashboard working daemon-absent.
 */
export class TerminalAiDetector implements vscode.Disposable {
    private scanTimer: NodeJS.Timeout | undefined;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly runningTools = new Map<string, number>();
    /** Canonical tool → ms timestamp of the last forwarded detection. */
    private readonly lastForwardedAt = new Map<string, number>();
    private readonly intervalMs: number;
    private readonly detectionDebounceMs: number;
    private readonly listTerminals: () => readonly vscode.Terminal[];
    private readonly onDidOpenTerminal: vscode.Event<vscode.Terminal>;
    private readonly onDidCloseTerminal: vscode.Event<vscode.Terminal>;
    private readonly runPs: () => Promise<string>;
    private isDisposed = false;
    private scanInFlight = false;

    constructor(
        private readonly forwarder: AiDetectionForwarder,
        private readonly logger: Logger,
        options: TerminalAiDetectorOptions = {}
    ) {
        this.intervalMs = options.intervalMs ?? TERMINAL_SCAN_INTERVAL_MS;
        this.detectionDebounceMs = options.detectionDebounceMs ?? TERMINAL_DETECTION_DEBOUNCE_MS;
        this.listTerminals = options.listTerminals ?? (() => vscode.window.terminals);
        this.onDidOpenTerminal = options.onDidOpenTerminal ?? vscode.window.onDidOpenTerminal;
        this.onDidCloseTerminal = options.onDidCloseTerminal ?? vscode.window.onDidCloseTerminal;
        this.runPs = options.runPs ?? runPsSnapshot;
    }

    public start(): void {
        if (this.isDisposed || this.scanTimer) {
            return;
        }

        this.subscriptions.push(
            this.onDidOpenTerminal(() => void this.scanNow()),
            this.onDidCloseTerminal(() => void this.scanNow())
        );

        this.scanTimer = setInterval(() => {
            void this.scanNow();
        }, this.intervalMs);

        void this.scanNow();
    }

    /**
     * Current local running state (tool → lastSeen), pruned to the
     * 2-missed-polls grace window — the dashboard's daemon-absent source.
     */
    public getRunningTools(): TerminalAiToolState[] {
        this.pruneStale(Date.now());
        return Array.from(this.runningTools.entries()).map(([tool, lastSeenAt]) => ({ tool, lastSeenAt }));
    }

    public async scanNow(): Promise<void> {
        if (this.isDisposed || this.scanInFlight) {
            return;
        }

        this.scanInFlight = true;
        try {
            await this.scan();
        } catch (error) {
            // Detection is strictly best-effort — a failed poll never surfaces.
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.debug(`Terminal AI scan failed: ${logError.message}`);
        } finally {
            this.scanInFlight = false;
        }
    }

    public dispose(): void {
        this.isDisposed = true;

        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = undefined;
        }

        for (const subscription of this.subscriptions.splice(0)) {
            try {
                subscription.dispose();
            } catch {
                /* best-effort */
            }
        }

        this.runningTools.clear();
        this.lastForwardedAt.clear();
    }

    private async scan(): Promise<void> {
        const now = Date.now();
        const terminals = this.listTerminals();
        if (terminals.length === 0) {
            this.pruneStale(now);
            return;
        }

        let psOutput: string;
        try {
            psOutput = await this.runPs();
        } catch {
            // `ps` unavailable or timed out (e.g. Windows) — no-op per design.
            return;
        }

        const childrenByPpid = buildChildIndex(parsePsOutput(psOutput));
        const detected = new Map<string, AiToolDetection>(); // canonical tool → detection

        for (const terminal of terminals) {
            let rootPid: number | undefined;
            try {
                rootPid = await terminal.processId;
            } catch {
                continue;
            }

            if (!rootPid) {
                continue;
            }

            collectAiDescendants(rootPid, childrenByPpid, detected);
        }

        for (const detection of detected.values()) {
            // lastSeen stays fresh on every poll regardless of forwarding.
            this.runningTools.set(detection.match.tool, now);
            this.forwardDetection(detection, now);
        }

        this.pruneStale(now);
    }

    private forwardDetection(detection: AiToolDetection, now: number): void {
        // Fallback mode buffers ingests indefinitely — a 10s presence poll would
        // grow that buffer without bound and replay stale detections later, so
        // forwarding is gated on a live daemon. Local running state still updates.
        if (!this.forwarder.isDaemonMode()) {
            return;
        }

        // Mirror the daemon ProcessWatcher's per-(scanner, tool) debounce:
        // forward when the tool is newly seen, then at most once per window
        // while it keeps running (the periodic re-emit keeps the daemon
        // session's lastActivityAt ahead of the stale-session sweep).
        const { tool, scannerId } = detection.match;
        const lastForwarded = this.lastForwardedAt.get(tool);
        if (lastForwarded !== undefined && now - lastForwarded < this.detectionDebounceMs) {
            return;
        }
        this.lastForwardedAt.set(tool, now);

        const envelope = buildAiToolDetectedEnvelope(
            tool,
            'terminal',
            TERMINAL_DETECTION_CONFIDENCE,
            `terminal:${tool}:${detection.pid}`,
            scannerId
        );

        void this.forwarder.ingest([envelope]).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Failed to forward terminal AI detection (${tool}): ${message}`);
        });
    }

    private pruneStale(now: number): void {
        const graceMs = this.intervalMs * TERMINAL_RUNNING_GRACE_POLLS;
        for (const [tool, lastSeenAt] of this.runningTools) {
            if (now - lastSeenAt > graceMs) {
                this.runningTools.delete(tool);
                // A pruned tool counts as newly seen if it reappears — forward
                // immediately instead of waiting out the debounce window.
                this.lastForwardedAt.delete(tool);
            }
        }
    }
}

function runPsSnapshot(): Promise<string> {
    return new Promise((resolve, reject) => {
        // Arg-array (no shell) keeps the invocation injection-safe.
        execFile(
            'ps',
            ['-ax', '-o', 'pid=,ppid=,comm='],
            {
                timeout: PS_TIMEOUT_MS,
                windowsHide: true,
                maxBuffer: PS_MAX_BUFFER_BYTES,
                encoding: 'utf8'
            },
            (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(stdout);
            }
        );
    });
}

function parsePsOutput(stdout: string): ProcessEntry[] {
    const entries: ProcessEntry[] = [];

    for (const line of stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (!match) {
            continue;
        }

        entries.push({
            pid: Number(match[1]),
            ppid: Number(match[2]),
            command: match[3].trim()
        });
    }

    return entries;
}

function buildChildIndex(entries: ProcessEntry[]): Map<number, ProcessEntry[]> {
    const childrenByPpid = new Map<number, ProcessEntry[]>();

    for (const entry of entries) {
        const siblings = childrenByPpid.get(entry.ppid);
        if (siblings) {
            siblings.push(entry);
        } else {
            childrenByPpid.set(entry.ppid, [entry]);
        }
    }

    return childrenByPpid;
}

/**
 * Matches a process basename against the known AI CLIs. The basename must
 * equal the CLI name or start with it followed by a non-alphanumeric boundary
 * ('claude' and 'claude-1.2' match; 'myclaudetool' and 'claudette' do not), so
 * an unrelated process whose name merely contains a CLI name cannot register.
 *
 * Residual limitation: process names are not authenticated — a local process
 * named exactly 'claude' still spoofs a detection. That is accepted for this
 * evidence path, which is why terminal evidence carries the lowest confidence
 * weight (TERMINAL_DETECTION_CONFIDENCE).
 */
function matchAiTool(command: string): CanonicalAiCliTool | undefined {
    const executable = (command.split(/[/\\]/).pop() ?? command).toLowerCase();
    return AI_CLI_TOOLS.find(entry => {
        if (!executable.startsWith(entry.cli)) {
            return false;
        }

        const boundary = executable.charAt(entry.cli.length);
        return boundary === '' || !/[a-z0-9]/.test(boundary);
    });
}

/** Breadth-first walk of a terminal's process subtree, bounded against runaway trees. */
function collectAiDescendants(
    rootPid: number,
    childrenByPpid: Map<number, ProcessEntry[]>,
    detected: Map<string, AiToolDetection>
): void {
    const queue: number[] = [rootPid];
    const visited = new Set<number>([rootPid]);

    while (queue.length > 0 && visited.size <= MAX_DESCENDANTS_PER_TERMINAL) {
        const pid = queue.shift();
        if (pid === undefined) {
            break;
        }

        for (const child of childrenByPpid.get(pid) ?? []) {
            if (visited.has(child.pid)) {
                continue;
            }

            visited.add(child.pid);

            const match = matchAiTool(child.command);
            if (match && !detected.has(match.tool)) {
                detected.set(match.tool, { match, pid: child.pid });
            }

            queue.push(child.pid);
        }
    }
}
