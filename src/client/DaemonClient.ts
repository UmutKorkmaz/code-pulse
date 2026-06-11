import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ConfigManager } from '../utils/ConfigManager';
import { Logger } from '../utils/Logger';
import type { CodingSession } from '../tracker/TimeTracker';

export const DEFAULT_DAEMON_HOST = '127.0.0.1';
export const DEFAULT_DAEMON_PORT = 7842;

export interface DaemonApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
    timestamp: string;
}

export interface DaemonHealth {
    status?: string;
    tracking?: boolean;
    database?: string;
    uptime?: number;
    version?: string;
}

export interface DaemonEnvelope {
    v: 1;
    id: string;
    ts: number;
    src: 'vscode';
    type: string;
    payload: Record<string, unknown>;
}

/**
 * One local-day × tool aggregate from GET /v1/ai/activity.
 * ALL time fields are milliseconds (open sessions count up to now).
 */
export interface AiActivityRow {
    /** Local calendar day (YYYY-MM-DD). */
    day?: string;
    tool?: string;
    /** Wall-clock run time in milliseconds. */
    runMs?: number;
    /** Gap-windowed active work time in milliseconds. */
    activeMs?: number;
    sessions?: number;
    inputTokens?: number;
    outputTokens?: number;
}

export interface AiActivityResponse {
    activity?: AiActivityRow[];
    total?: number;
}

/** One AI session row from GET /v1/ai/sessions. Time fields are milliseconds. */
export interface AiSessionSummary {
    id?: string;
    tool?: string;
    model?: string;
    startedAt?: string;
    endedAt?: string;
    /** Wall-clock run time in milliseconds (open sessions count up to now). */
    durationMs?: number;
    /** Gap-windowed active work time in milliseconds. */
    activeDurationMs?: number;
    /** ISO timestamp of the most recent activity event. */
    lastActivityAt?: string;
    /** True while the session has no ended_at. */
    isActive?: boolean;
    inputTokens?: number;
    outputTokens?: number;
}

export interface AiSessionsResponse {
    sessions?: AiSessionSummary[];
    total?: number;
}

export type DaemonClientMode = 'daemon' | 'fallback';

export class DaemonClient {
    private host = DEFAULT_DAEMON_HOST;
    private port = DEFAULT_DAEMON_PORT;
    private token: string | undefined;
    private timeoutMs = 10_000;
    private mode: DaemonClientMode = 'fallback';
    private flushTimer: NodeJS.Timeout | undefined;
    private readonly pendingEvents: DaemonEnvelope[] = [];
    private sessionProvider: (() => CodingSession | null | undefined) | undefined;
    private lastForwardedFingerprint: string | undefined;
    private lastSeenSession: CodingSession | undefined;
    private lastEndedSessionId: string | undefined;
    private reconnectTimer: NodeJS.Timeout | undefined;
    private readonly reconnectProbeMs = 60_000;
    private reconnectedHandler: (() => void | Promise<void>) | undefined;

    constructor(
        private readonly configManager: ConfigManager,
        private readonly logger: Logger
    ) {}

    public getMode(): DaemonClientMode {
        return this.mode;
    }

    public isDaemonMode(): boolean {
        return this.mode === 'daemon';
    }

    public isFallbackMode(): boolean {
        return this.mode === 'fallback';
    }

    public getBaseUrl(): string {
        return `http://${this.host}:${this.port}`;
    }

    public async connect(): Promise<boolean> {
        this.loadConnectionSettings();

        try {
            await this.getHealth();
            this.mode = 'daemon';
            this.clearReconnectProbe();
            this.logger.info(`Connected to Code Pulse daemon at ${this.getBaseUrl()}`);
            return true;
        } catch (error) {
            this.mode = 'fallback';
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Daemon unavailable, using embedded fallback mode: ${message}`);
            // Arm the probe so a daemon started after VS Code is eventually picked up.
            if (this.configManager.isDaemonEnabled()) {
                this.scheduleReconnectProbe();
            }
            return false;
        }
    }

    public async disconnect(): Promise<void> {
        this.stopForwarding();
        this.clearReconnectProbe();

        if (this.mode === 'daemon' && this.pendingEvents.length > 0) {
            try {
                await this.flushPendingEvents();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(`Failed to flush pending daemon events during disconnect: ${message}`);
            }
        }

        this.pendingEvents.length = 0;
        this.mode = 'fallback';
    }

    public startForwarding(getCurrentSession: () => CodingSession | null | undefined, intervalMs = 2000): void {
        this.stopForwarding();
        this.sessionProvider = getCurrentSession;

        this.flushTimer = setInterval(() => {
            void this.forwardCurrentSession();
        }, intervalMs);
    }

    public stopForwarding(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = undefined;
        }

        this.sessionProvider = undefined;
        this.lastSeenSession = undefined;
        this.lastForwardedFingerprint = undefined;
    }

    /**
     * Registers a callback invoked after the reconnect probe restores daemon mode,
     * so the extension can re-run its daemon wiring (forwarding, context keys).
     */
    public setReconnectedHandler(handler: (() => void | Promise<void>) | undefined): void {
        this.reconnectedHandler = handler;
    }

    /**
     * Emits a final session.ended envelope for a session that just finished.
     * TimeTracker hands the finalized session here before nulling its state.
     */
    public notifySessionEnded(session: CodingSession): void {
        this.emitSessionEnded({ ...session, isActive: false });
    }

    public async ingest(events: DaemonEnvelope[]): Promise<void> {
        if (!events.length) {
            return;
        }

        if (this.isFallbackMode()) {
            this.pendingEvents.push(...events);
            return;
        }

        try {
            await this.postEvents(events);
        } catch (error) {
            this.mode = 'fallback';
            this.pendingEvents.push(...events);
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Daemon ingest failed, switching to fallback mode: ${message}`);
            this.scheduleReconnectProbe();
        }
    }

    /**
     * Fetches per-day, per-tool AI run/active aggregates (GET /v1/ai/activity).
     * All time fields are milliseconds. Fallback-safe: resolves to an empty
     * response instead of throwing when the daemon is unreachable.
     */
    public async getAiActivity(days = 7): Promise<AiActivityResponse> {
        if (this.isFallbackMode()) {
            return { activity: [], total: 0 };
        }

        const clampedDays = Math.max(1, Math.floor(days) || 1);

        try {
            const response = await this.request<AiActivityResponse>('GET', `/v1/ai/activity?days=${clampedDays}`);
            return response.data ?? { activity: [], total: 0 };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Failed to fetch AI activity from daemon: ${message}`);
            return { activity: [], total: 0 };
        }
    }

    /**
     * Fetches recent AI sessions (GET /v1/ai/sessions) including activeDurationMs,
     * lastActivityAt, and isActive. Fallback-safe like getAiActivity.
     */
    public async getAiSessions(limit = 50): Promise<AiSessionsResponse> {
        if (this.isFallbackMode()) {
            return { sessions: [], total: 0 };
        }

        const clampedLimit = Math.max(1, Math.floor(limit) || 1);

        try {
            const response = await this.request<AiSessionsResponse>('GET', `/v1/ai/sessions?limit=${clampedLimit}`);
            return response.data ?? { sessions: [], total: 0 };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Failed to fetch AI sessions from daemon: ${message}`);
            return { sessions: [], total: 0 };
        }
    }

    public async refreshConnection(): Promise<void> {
        if (!this.configManager.isDaemonEnabled()) {
            await this.disconnect();
            return;
        }

        await this.connect();

        if (this.isDaemonMode()) {
            try {
                await this.flushPendingEvents();
            } catch (error) {
                // Events were re-queued by flushPendingEvents — never let a flush failure
                // escape into the configuration-change handler.
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(`Failed to flush buffered daemon events after reconnect: ${message}`);
                return;
            }

            if (this.sessionProvider) {
                await this.forwardCurrentSession();
            }
        }
    }

    private loadConnectionSettings(): void {
        this.host = this.configManager.get('daemon.host', DEFAULT_DAEMON_HOST);
        this.port = this.configManager.get('daemon.port', DEFAULT_DAEMON_PORT);
        this.timeoutMs = this.configManager.get('daemon.timeoutMs', 10_000);
        this.token = this.readDaemonToken();
    }

    private readDaemonToken(): string | undefined {
        const configuredToken = this.configManager.get<string>('daemon.token', '').trim();
        if (configuredToken) {
            return configuredToken;
        }

        const tokenPath = path.join(this.getCodePulseHome(), 'token');
        try {
            const token = fs.readFileSync(tokenPath, 'utf8').trim();
            return token || undefined;
        } catch {
            return undefined;
        }
    }

    private getCodePulseHome(): string {
        const override = process.env.CODEPULSE_HOME?.trim();
        if (override) {
            return path.resolve(override);
        }

        if (process.platform === 'win32') {
            return path.join(process.env.USERPROFILE || os.homedir(), '.codepulse');
        }

        return path.join(os.homedir(), '.codepulse');
    }

    private async forwardCurrentSession(): Promise<void> {
        if (!this.sessionProvider) {
            return;
        }

        const session = this.sessionProvider();
        if (!session) {
            // Session ended between ticks without an explicit notifySessionEnded call —
            // emit a final session.ended envelope from the last snapshot we saw.
            if (this.lastSeenSession && this.lastSeenSession.id !== this.lastEndedSessionId) {
                this.emitSessionEnded({ ...this.lastSeenSession, isActive: false, endTime: new Date() });
            }

            this.lastSeenSession = undefined;
            return;
        }

        // Session rotated between ticks (e.g. synchronous end+start on project/language
        // switch) — close out the previous session before forwarding the new one.
        const previousSession = this.lastSeenSession;
        if (previousSession && previousSession.id !== session.id) {
            this.emitSessionEnded({
                ...previousSession,
                isActive: false,
                endTime: previousSession.endTime ?? new Date()
            });
        }

        this.lastSeenSession = session;

        if (this.isFallbackMode()) {
            return;
        }

        const fingerprint = this.buildSessionFingerprint(session);
        if (fingerprint === this.lastForwardedFingerprint) {
            return;
        }

        this.lastForwardedFingerprint = fingerprint;
        await this.ingest([this.buildSessionEnvelope(session)]);
    }

    private emitSessionEnded(session: CodingSession): void {
        if (session.id === this.lastEndedSessionId) {
            return;
        }

        this.lastEndedSessionId = session.id;
        if (this.lastSeenSession?.id === session.id) {
            this.lastSeenSession = undefined;
        }

        this.lastForwardedFingerprint = undefined;
        void this.ingest([this.buildSessionEnvelope(session)]);
    }

    private buildSessionFingerprint(session: CodingSession): string {
        const minuteMs = 60_000;

        return JSON.stringify({
            id: session.id,
            isActive: session.isActive,
            project: session.project,
            language: session.language,
            file: session.file,
            branch: session.branch,
            heartbeats: session.heartbeats,
            keystrokes: session.keystrokes,
            linesAdded: session.linesAdded,
            linesRemoved: session.linesRemoved,
            productivityScore: session.productivityScore,
            tags: session.tags,
            // Durations tick every interval — quantize so pure wall-clock drift is not "a change"
            durationMinutes: Math.floor(session.duration / minuteMs),
            idleMinutes: Math.floor(session.idleDuration / minuteMs)
        });
    }

    private scheduleReconnectProbe(): void {
        if (this.reconnectTimer) {
            return;
        }

        this.reconnectTimer = setInterval(() => {
            void this.probeReconnect();
        }, this.reconnectProbeMs);
    }

    private clearReconnectProbe(): void {
        if (this.reconnectTimer) {
            clearInterval(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }

    private async probeReconnect(): Promise<void> {
        if (this.isDaemonMode() || !this.configManager.isDaemonEnabled()) {
            this.clearReconnectProbe();
            return;
        }

        try {
            await this.getHealth();
        } catch {
            return; // Daemon still unreachable — keep probing.
        }

        this.mode = 'daemon';
        this.clearReconnectProbe();
        this.logger.info(
            this.sessionProvider
                ? 'Reconnected to Code Pulse daemon, resuming event forwarding'
                : 'Reconnected to Code Pulse daemon'
        );

        try {
            await this.flushPendingEvents();
        } catch (error) {
            this.mode = 'fallback';
            this.scheduleReconnectProbe();
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Failed to flush buffered daemon events after reconnect: ${message}`);
            return;
        }

        // Let the extension re-run its daemon wiring so forwarding and the
        // codepulse.daemon.connected context genuinely resume.
        if (this.reconnectedHandler) {
            try {
                await this.reconnectedHandler();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(`Daemon reconnected handler failed: ${message}`);
            }
        }
    }

    private async flushPendingEvents(): Promise<void> {
        if (!this.pendingEvents.length || this.isFallbackMode()) {
            return;
        }

        const batch = this.pendingEvents.splice(0, this.pendingEvents.length);
        try {
            await this.postEvents(batch);
        } catch (error) {
            this.pendingEvents.unshift(...batch);
            throw error;
        }
    }

    private buildSessionEnvelope(session: CodingSession): DaemonEnvelope {
        const payload = {
            type: session.isActive ? 'session.updated' : 'session.ended',
            session: {
                id: session.id,
                startTime: session.startTime.toISOString(),
                endTime: session.endTime?.toISOString(),
                // TimeTracker accumulates durations in ms; the daemon protocol
                // contract (protocol/src/envelope.ts CodingSession) is seconds.
                duration: Math.round(session.duration / 1000),
                idleDuration: Math.round(session.idleDuration / 1000),
                project: session.project,
                language: session.language,
                file: session.file,
                branch: session.branch,
                isActive: session.isActive,
                heartbeats: session.heartbeats,
                keystrokes: session.keystrokes,
                linesAdded: session.linesAdded,
                linesRemoved: session.linesRemoved,
                productivityScore: session.productivityScore,
                tags: session.tags
            }
        };

        return {
            v: 1,
            id: uuidv4(),
            ts: Date.now(),
            src: 'vscode',
            type: payload.type,
            payload
        };
    }

    private async getHealth(): Promise<DaemonHealth> {
        const response = await this.request<DaemonHealth>('GET', '/v1/health');
        if (!response.success) {
            throw new Error(response.error || 'Daemon health check failed');
        }

        return (response.data || {}) as DaemonHealth;
    }

    private async postEvents(events: DaemonEnvelope[]): Promise<void> {
        const response = await this.request<{ accepted?: number }>('POST', '/v1/events/ingest', { events });
        if (!response.success) {
            throw new Error(response.error || 'Daemon event ingest failed');
        }
    }

    private async request<T>(
        method: 'GET' | 'POST',
        pathname: string,
        body?: Record<string, unknown>
    ): Promise<DaemonApiResponse<T>> {
        const payload = body ? JSON.stringify(body) : undefined;

        return new Promise((resolve, reject) => {
            const headers: http.OutgoingHttpHeaders = {
                Accept: 'application/json'
            };

            if (payload) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = Buffer.byteLength(payload);
            }

            if (this.token) {
                headers.Authorization = `Bearer ${this.token}`;
            }

            const requestOptions: http.RequestOptions = {
                hostname: this.host,
                port: this.port,
                path: pathname,
                method,
                headers,
                timeout: this.timeoutMs
            };

            const req = http.request(requestOptions, res => {
                let responseText = '';

                res.on('data', chunk => {
                    responseText += chunk.toString();
                });

                res.on('end', () => {
                    let parsed: DaemonApiResponse<T>;

                    try {
                        parsed = JSON.parse(responseText) as DaemonApiResponse<T>;
                    } catch {
                        reject(
                            new Error(
                                res.statusCode && res.statusCode >= 400
                                    ? `Daemon error ${res.statusCode} ${res.statusMessage || ''}`.trim()
                                    : `Invalid JSON from daemon (${pathname})`
                            )
                        );
                        return;
                    }

                    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300 || !parsed.success) {
                        reject(new Error(parsed.error || `Daemon error ${res.statusCode} ${res.statusMessage || ''}`.trim()));
                        return;
                    }

                    resolve(parsed);
                });
            });

            req.on('timeout', () => {
                req.destroy(new Error(`Daemon request timed out after ${this.timeoutMs}ms (${pathname})`));
            });

            req.on('error', error => {
                if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
                    reject(new Error(`Cannot reach Code Pulse daemon at ${this.getBaseUrl()}. Is codepulse-d running?`));
                    return;
                }

                reject(error);
            });

            if (payload) {
                req.write(payload);
            }

            req.end();
        });
    }
}