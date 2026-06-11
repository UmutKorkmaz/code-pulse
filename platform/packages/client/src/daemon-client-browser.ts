import type {
    AiActivityResponse,
    AiSessionsResponse,
    DaemonClientOptions,
    DaemonHealth,
    DaemonResponse,
    DaemonStatus,
    FileSnapshot,
    PingResult,
    RegistryList,
    RestoreSnapshotResult,
    SessionsResponse,
    SnapshotListResponse,
    TokenAggregate
} from './types.js';
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from './constants.js';

export { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT };

/**
 * Browser-safe daemon client — never imports node:fs. Token must be supplied via
 * options or VITE_DAEMON_TOKEN; no filesystem reads.
 */
export class BrowserDaemonClient {
    private readonly host: string;
    private readonly port: number;
    private token?: string;
    private readonly timeoutMs: number;
    constructor(options: DaemonClientOptions = {}) {
        this.host = options.host ?? DEFAULT_DAEMON_HOST;
        this.port = options.port ?? DEFAULT_DAEMON_PORT;
        this.token = options.token;
        this.timeoutMs = options.timeoutMs ?? 10_000;
    }

    getBaseUrl(): string {
        return `http://${this.host}:${this.port}`;
    }

    hasToken(): boolean {
        return Boolean(this.token);
    }

    async ping(): Promise<PingResult> {
        const started = Date.now();
        try {
            const health = await this.getHealth();
            return { ok: true, latencyMs: Date.now() - started, health };
        } catch (error) {
            return {
                ok: false,
                latencyMs: Date.now() - started,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    async getStatus(): Promise<DaemonStatus> {
        return this.fetchData<DaemonStatus>('/v1/status');
    }

    async getHealth(): Promise<DaemonHealth> {
        return this.fetchData<DaemonHealth>('/v1/health');
    }

    async getRegistry(): Promise<RegistryList> {
        return this.fetchData<RegistryList>('/v1/registry');
    }

    async getTodayTokens(): Promise<TokenAggregate[]> {
        const today = new Date().toISOString().slice(0, 10);
        const data = await this.fetchData<TokenAggregate[] | { tokens?: TokenAggregate[] }>(
            `/v1/ai/tokens?days=1&day=${today}`
        );
        return Array.isArray(data) ? data : (data.tokens ?? []);
    }

    async getAiSessions(limit = 50): Promise<AiSessionsResponse> {
        return this.fetchData<AiSessionsResponse>(`/v1/ai/sessions?limit=${limit}`);
    }

    async fetchSessions(days = 7, limit = 200): Promise<SessionsResponse> {
        return this.fetchData<SessionsResponse>(`/v1/sessions?days=${days}&limit=${limit}`);
    }

    /** Daily AI run/active-time aggregates; all time fields are milliseconds. */
    async fetchAiActivity(days = 7): Promise<AiActivityResponse> {
        return this.fetchData<AiActivityResponse>(`/v1/ai/activity?days=${days}`);
    }

    async listSnapshots(limit = 50): Promise<FileSnapshot[]> {
        const data = await this.fetchData<SnapshotListResponse>(`/v1/snapshots?limit=${limit}`);
        return data.snapshots ?? [];
    }

    async restoreSnapshotDryRun(snapshotId: string): Promise<RestoreSnapshotResult> {
        return this.postData<RestoreSnapshotResult>(
            `/v1/snapshots/${encodeURIComponent(snapshotId)}/restore?dry_run=true`
        );
    }

    async restoreSnapshotConfirmed(
        snapshotId: string,
        recoveryToken: string
    ): Promise<RestoreSnapshotResult> {
        const params = new URLSearchParams({
            dry_run: 'false',
            recovery_token: recoveryToken
        });
        return this.postData<RestoreSnapshotResult>(
            `/v1/snapshots/${encodeURIComponent(snapshotId)}/restore?${params.toString()}`
        );
    }

    private async fetchData<T>(pathname: string): Promise<T> {
        const response = await this.request(pathname, 'GET');
        if (!response.success) {
            throw new Error(response.error || `Daemon request failed for ${pathname}`);
        }
        return response.data as T;
    }

    private async postData<T>(pathname: string, body?: unknown): Promise<T> {
        const response = await this.request(pathname, 'POST', body);
        if (!response.success) {
            throw new Error(response.error || `Daemon request failed for ${pathname}`);
        }
        return response.data as T;
    }

    private async ensureToken(): Promise<void> {
        if (this.token) {
            return;
        }

        try {
            const response = await fetch(`${this.getBaseUrl()}/v1/bootstrap`, {
                method: 'GET',
                headers: { Accept: 'application/json' }
            });
            if (!response.ok) {
                return;
            }
            const payload = (await response.json()) as DaemonResponse<{
                token?: string;
            }>;
            if (payload.success && payload.data?.token) {
                this.token = payload.data.token;
            }
        } catch {
            // Bootstrap is best-effort for local desktop/vite clients.
        }
    }

    private async request(
        pathname: string,
        method: 'GET' | 'POST' = 'GET',
        body?: unknown
    ): Promise<DaemonResponse> {
        if (pathname !== '/v1/bootstrap') {
            await this.ensureToken();
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const headers: Record<string, string> = { Accept: 'application/json' };
            if (this.token) {
                headers.Authorization = `Bearer ${this.token}`;
            }
            if (body !== undefined) {
                headers['Content-Type'] = 'application/json';
            }

            let response = await fetch(`${this.getBaseUrl()}${pathname}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });

            if (response.status === 401 && pathname !== '/v1/bootstrap') {
                this.token = undefined;
                await this.ensureToken();
                if (this.token) {
                    headers.Authorization = `Bearer ${this.token}`;
                    response = await fetch(`${this.getBaseUrl()}${pathname}`, {
                        method,
                        headers,
                        body: body === undefined ? undefined : JSON.stringify(body),
                        signal: controller.signal
                    });
                }
            }

            const bodyText = await response.text();
            let payload: DaemonResponse;
            try {
                payload = JSON.parse(bodyText) as DaemonResponse;
            } catch {
                throw new Error(
                    response.ok
                        ? `Invalid JSON from daemon (${pathname})`
                        : `Daemon error ${response.status} ${response.statusText}`
                );
            }

            if (!response.ok) {
                throw new Error(payload.error || `Daemon error ${response.status} ${response.statusText}`);
            }
            return payload;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Daemon request timed out after ${this.timeoutMs}ms (${pathname})`);
            }
            if (error instanceof TypeError) {
                throw new Error(
                    `Cannot reach Code Pulse daemon at ${this.getBaseUrl()}. Is codepulse-d running?`
                );
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }
}

export function createBrowserDaemonClient(options?: DaemonClientOptions): BrowserDaemonClient {
    return new BrowserDaemonClient(options);
}