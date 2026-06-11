import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from './constants.js';
export { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT };
/**
 * Browser-safe daemon client — never imports node:fs. Token must be supplied via
 * options or VITE_DAEMON_TOKEN; no filesystem reads.
 */
export class BrowserDaemonClient {
    host;
    port;
    token;
    timeoutMs;
    constructor(options = {}) {
        this.host = options.host ?? DEFAULT_DAEMON_HOST;
        this.port = options.port ?? DEFAULT_DAEMON_PORT;
        this.token = options.token;
        this.timeoutMs = options.timeoutMs ?? 10_000;
    }
    getBaseUrl() {
        return `http://${this.host}:${this.port}`;
    }
    hasToken() {
        return Boolean(this.token);
    }
    async ping() {
        const started = Date.now();
        try {
            const health = await this.getHealth();
            return { ok: true, latencyMs: Date.now() - started, health };
        }
        catch (error) {
            return {
                ok: false,
                latencyMs: Date.now() - started,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
    async getStatus() {
        return this.fetchData('/v1/status');
    }
    async getHealth() {
        return this.fetchData('/v1/health');
    }
    async getRegistry() {
        return this.fetchData('/v1/registry');
    }
    async getTodayTokens() {
        const today = new Date().toISOString().slice(0, 10);
        const data = await this.fetchData(`/v1/ai/tokens?days=1&day=${today}`);
        return Array.isArray(data) ? data : (data.tokens ?? []);
    }
    async getAiSessions(limit = 50) {
        return this.fetchData(`/v1/ai/sessions?limit=${limit}`);
    }
    async fetchSessions(days = 7, limit = 200) {
        return this.fetchData(`/v1/sessions?days=${days}&limit=${limit}`);
    }
    /** Daily AI run/active-time aggregates; all time fields are milliseconds. */
    async fetchAiActivity(days = 7) {
        return this.fetchData(`/v1/ai/activity?days=${days}`);
    }
    async listSnapshots(limit = 50) {
        const data = await this.fetchData(`/v1/snapshots?limit=${limit}`);
        return data.snapshots ?? [];
    }
    async restoreSnapshotDryRun(snapshotId) {
        return this.postData(`/v1/snapshots/${encodeURIComponent(snapshotId)}/restore?dry_run=true`);
    }
    async restoreSnapshotConfirmed(snapshotId, recoveryToken) {
        const params = new URLSearchParams({
            dry_run: 'false',
            recovery_token: recoveryToken
        });
        return this.postData(`/v1/snapshots/${encodeURIComponent(snapshotId)}/restore?${params.toString()}`);
    }
    async fetchData(pathname) {
        const response = await this.request(pathname, 'GET');
        if (!response.success) {
            throw new Error(response.error || `Daemon request failed for ${pathname}`);
        }
        return response.data;
    }
    async postData(pathname, body) {
        const response = await this.request(pathname, 'POST', body);
        if (!response.success) {
            throw new Error(response.error || `Daemon request failed for ${pathname}`);
        }
        return response.data;
    }
    async ensureToken() {
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
            const payload = (await response.json());
            if (payload.success && payload.data?.token) {
                this.token = payload.data.token;
            }
        }
        catch {
            // Bootstrap is best-effort for local desktop/vite clients.
        }
    }
    async request(pathname, method = 'GET', body) {
        if (pathname !== '/v1/bootstrap') {
            await this.ensureToken();
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const headers = { Accept: 'application/json' };
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
            let payload;
            try {
                payload = JSON.parse(bodyText);
            }
            catch {
                throw new Error(response.ok
                    ? `Invalid JSON from daemon (${pathname})`
                    : `Daemon error ${response.status} ${response.statusText}`);
            }
            if (!response.ok) {
                throw new Error(payload.error || `Daemon error ${response.status} ${response.statusText}`);
            }
            return payload;
        }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Daemon request timed out after ${this.timeoutMs}ms (${pathname})`);
            }
            if (error instanceof TypeError) {
                throw new Error(`Cannot reach Code Pulse daemon at ${this.getBaseUrl()}. Is codepulse-d running?`);
            }
            throw error;
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
export function createBrowserDaemonClient(options) {
    return new BrowserDaemonClient(options);
}
//# sourceMappingURL=daemon-client-browser.js.map