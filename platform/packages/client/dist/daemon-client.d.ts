import type { AiActivityResponse, AiSessionsResponse, DaemonClientOptions, DaemonHealth, DaemonStatus, PingResult, RegistryList, SessionsResponse, TokenAggregate } from './types.js';
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from './paths-node.js';
export declare class DaemonClient {
    private readonly host;
    private readonly port;
    private readonly token?;
    private readonly timeoutMs;
    constructor(options?: DaemonClientOptions);
    getBaseUrl(): string;
    getHomeDir(): string;
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
    private fetchData;
    private request;
}
export declare function createDaemonClient(options?: DaemonClientOptions): DaemonClient;
export { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT };
//# sourceMappingURL=daemon-client.d.ts.map