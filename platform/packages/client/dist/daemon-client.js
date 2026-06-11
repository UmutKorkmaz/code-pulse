import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT, getCodePulseHome, readDaemonHost, readDaemonPort, readDaemonToken } from './paths-node.js';
export class DaemonClient {
    host;
    port;
    token;
    timeoutMs;
    constructor(options = {}) {
        this.host = options.host ?? readDaemonHost();
        this.port = options.port ?? readDaemonPort();
        this.token = options.token ?? readDaemonToken();
        this.timeoutMs = options.timeoutMs ?? 10_000;
    }
    getBaseUrl() {
        return `http://${this.host}:${this.port}`;
    }
    getHomeDir() {
        return getCodePulseHome();
    }
    hasToken() {
        return Boolean(this.token);
    }
    async ping() {
        const started = Date.now();
        try {
            const health = await this.getHealth();
            return {
                ok: true,
                latencyMs: Date.now() - started,
                health
            };
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
        if (Array.isArray(data)) {
            return data;
        }
        return data.tokens ?? [];
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
    async fetchData(pathname) {
        const response = await this.request(pathname);
        if (!response.success) {
            throw new Error(response.error || `Daemon request failed for ${pathname}`);
        }
        return response.data;
    }
    async request(pathname) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const headers = {
                Accept: 'application/json'
            };
            if (this.token) {
                headers.Authorization = `Bearer ${this.token}`;
            }
            const response = await fetch(`${this.getBaseUrl()}${pathname}`, {
                method: 'GET',
                headers,
                signal: controller.signal
            });
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
export function createDaemonClient(options) {
    return new DaemonClient(options);
}
export { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT };
//# sourceMappingURL=daemon-client.js.map