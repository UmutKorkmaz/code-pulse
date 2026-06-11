import type { AiActivityResponse, AiSessionsResponse, DaemonClientOptions, DaemonHealth, DaemonStatus, FileSnapshot, PingResult, RegistryList, RestoreSnapshotResult, SessionsResponse, TokenAggregate } from './types.js';
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from './constants.js';
export { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT };
/**
 * Browser-safe daemon client — never imports node:fs. Token must be supplied via
 * options or VITE_DAEMON_TOKEN; no filesystem reads.
 */
export declare class BrowserDaemonClient {
    private readonly host;
    private readonly port;
    private token?;
    private readonly timeoutMs;
    constructor(options?: DaemonClientOptions);
    getBaseUrl(): string;
    hasToken(): boolean;
    ping(): Promise<PingResult>;
    getStatus(): Promise<DaemonStatus>;
    getHealth(): Promise<DaemonHealth>;
    getRegistry(): Promise<RegistryList>;
    getTodayTokens(): Promise<TokenAggregate[]>;
    getAiSessions(limit?: number): Promise<AiSessionsResponse>;
    fetchSessions(days?: number, limit?: number): Promise<SessionsResponse>;
    /** Daily AI run/active-time aggregates; all time fields are milliseconds. */
    fetchAiActivity(days?: number): Promise<AiActivityResponse>;
    listSnapshots(limit?: number): Promise<FileSnapshot[]>;
    restoreSnapshotDryRun(snapshotId: string): Promise<RestoreSnapshotResult>;
    restoreSnapshotConfirmed(snapshotId: string, recoveryToken: string): Promise<RestoreSnapshotResult>;
    private fetchData;
    private postData;
    private ensureToken;
    private request;
}
export declare function createBrowserDaemonClient(options?: DaemonClientOptions): BrowserDaemonClient;
//# sourceMappingURL=daemon-client-browser.d.ts.map