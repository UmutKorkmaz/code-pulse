import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { TimeTracker } from '../tracker/TimeTracker';
import { DatabaseManager } from '../storage/DatabaseManager';
import { ConfigManager } from '../utils/ConfigManager';

export interface ApiResponse {
    success: boolean;
    data?: any;
    error?: string;
    timestamp: string;
}

/**
 * Loopback host names/addresses accepted in the Host header. Anything else is a
 * DNS-rebinding attempt (a public DNS name resolving to 127.0.0.1) and is
 * rejected before routing. An optional port suffix is allowed. Mirrors the
 * daemon's ALLOWED_HOST_PATTERNS in platform/apps/daemon/src/http/cors.ts.
 */
const ALLOWED_HOST_PATTERNS = [
    /^127\.0\.0\.1(?::\d+)?$/,
    /^localhost(?::\d+)?$/,
    /^\[::1\](?::\d+)?$/
];

/**
 * Returns true when the request's Host header is a loopback host. Requests with
 * a missing Host header are rejected (an HTTP/1.1 request must send one).
 */
function isLoopbackHost(req: http.IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host || typeof host !== 'string') {
        return false;
    }
    return ALLOWED_HOST_PATTERNS.some(pattern => pattern.test(host));
}

/** Length-checked, constant-time string comparison for bearer tokens. */
function timingSafeEqualString(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');
    if (bufferA.length !== bufferB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Resolves the API token for the local server. Prefers the configured
 * `localServer.apiToken` setting when non-empty; otherwise reads (or generates
 * once and persists) a random token at `<storagePath>/api-token` with mode
 * 0600. Mirrors the daemon's `~/.codepulse/token` pattern in
 * platform/apps/daemon/src/config.ts (ensureAuthToken).
 */
export function resolveApiToken(configManager: ConfigManager, storagePath?: string): string {
    const configured = configManager.get<string>('localServer.apiToken', '').trim();
    if (configured) {
        return configured;
    }

    if (!storagePath) {
        // No persistence location available: generate an ephemeral token so auth
        // still fails closed (every request needs a token the caller cannot know).
        return crypto.randomUUID();
    }

    const tokenPath = path.join(storagePath, 'api-token');
    try {
        const existing = fs.readFileSync(tokenPath, 'utf8').trim();
        if (existing) {
            return existing;
        }
    } catch {
        // File does not exist yet (or is unreadable); fall through to generate one.
    }

    const token = crypto.randomUUID();
    try {
        fs.mkdirSync(storagePath, { recursive: true });
        fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    } catch (error) {
        console.error('Failed to persist generated API token:', error);
    }
    return token;
}

export interface ApiStats {
    requestsTotal: number;
    requestsByEndpoint: { [endpoint: string]: number };
    requestsByMethod: { [method: string]: number };
    averageResponseTime: number;
    uptime: number;
    startTime: Date;
}

export class ApiServer {
    private server: http.Server | null = null;
    private port: number;
    private isRunning = false;
    private allowExternalConnections: boolean;
    private stats: ApiStats;
    private requestTimes: number[] = [];

    constructor(
        private timeTracker: TimeTracker,
        private databaseManager: DatabaseManager,
        private configManager: ConfigManager,
        private storagePath?: string
    ) {
        this.port = this.configManager.get('localServer.port', 8080);
        this.allowExternalConnections = this.configManager.get('localServer.allowExternalConnections', false);

        this.stats = {
            requestsTotal: 0,
            requestsByEndpoint: {},
            requestsByMethod: {},
            averageResponseTime: 0,
            uptime: 0,
            startTime: new Date()
        };
    }

    public async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error('API server is already running');
        }

        return new Promise((resolve, reject) => {
            try {
                this.server = http.createServer((req, res) => {
                    this.handleRequest(req, res);
                });

                const host = this.allowExternalConnections ? '0.0.0.0' : '127.0.0.1';

                this.server.listen(this.port, host, () => {
                    this.isRunning = true;
                    this.stats.startTime = new Date();
                    // Server started successfully
                    resolve();
                });

                this.server.on('error', (error: any) => {
                    if (error.code === 'EADDRINUSE') {
                        reject(new Error(`Port ${this.port} is already in use`));
                    } else if (error.code === 'EACCES') {
                        reject(new Error(`Access denied to port ${this.port}. Try a port above 1024.`));
                    } else {
                        reject(new Error(`Failed to start server: ${error.message}`));
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    public async stop(): Promise<void> {
        if (!this.isRunning || !this.server) {
            return;
        }

        return new Promise(resolve => {
            this.server!.close(() => {
                this.isRunning = false;
                this.server = null;
                // Server stopped
                resolve();
            });
        });
    }

    public getStats(): ApiStats {
        this.stats.uptime = Date.now() - this.stats.startTime.getTime();
        return { ...this.stats };
    }

    public isServerRunning(): boolean {
        return this.isRunning;
    }

    public getPort(): number {
        return this.port;
    }

    /**
     * Returns the active API token (configured setting if set, otherwise the
     * persisted auto-generated one). Used by the copy-token command so external
     * consumers can discover the token regardless of server run state.
     */
    public getActiveToken(): string {
        return resolveApiToken(this.configManager, this.storagePath);
    }

    public updateConfiguration(): void {
        const newPort = this.configManager.get('localServer.port', 8080);
        const newAllowExternal = this.configManager.get('localServer.allowExternalConnections', false);
        const shouldEnable = this.configManager.get('localServer.enabled', false);

        if (!shouldEnable && this.isRunning) {
            this.stop();
        } else if (shouldEnable && !this.isRunning) {
            this.start().catch(console.error);
        } else if (this.isRunning && (newPort !== this.port || newAllowExternal !== this.allowExternalConnections)) {
            // Restart server with new configuration
            this.port = newPort;
            this.allowExternalConnections = newAllowExternal;
            this.stop()
                .then(() => this.start())
                .catch(console.error);
        }
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const startTime = Date.now();
        let pathname = '';
        let query: Record<string, string> = {};

        try {
            // Enable CORS
            res.setHeader('Access-Control-Allow-Origin', this.allowExternalConnections ? '*' : 'http://localhost');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            res.setHeader('Content-Type', 'application/json');

            // DNS-rebinding defense: reject any request whose Host header is not a
            // loopback name/address. Applies to EVERY route, before auth/routing.
            if (!isLoopbackHost(req)) {
                const errorResponse: ApiResponse = {
                    success: false,
                    error: 'Forbidden host',
                    timestamp: new Date().toISOString()
                };
                res.writeHead(403);
                res.end(JSON.stringify(errorResponse));
                return;
            }

            // Handle preflight requests
            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            const parsedUrl = new URL(req.url || '', `http://localhost:${this.port}`);
            pathname = parsedUrl.pathname || '';
            parsedUrl.searchParams.forEach((value, key) => {
                query[key] = value;
            });

            // Auth is required on EVERY bind (localhost included). The full
            // coding-activity DB is served here, so an unauthenticated local
            // process (or a web page via localhost fetch) must never read it.
            const expectedToken = resolveApiToken(this.configManager, this.storagePath);
            const providedToken = this.getBearerToken(req, query);
            if (!expectedToken || !providedToken || !timingSafeEqualString(providedToken, expectedToken)) {
                const errorResponse: ApiResponse = {
                    success: false,
                    error: 'Unauthorized: missing or invalid local API token',
                    timestamp: new Date().toISOString()
                };
                res.setHeader('WWW-Authenticate', 'Bearer');
                res.writeHead(401);
                res.end(JSON.stringify(errorResponse));
                return;
            }

            // Update stats
            this.stats.requestsTotal++;
            this.stats.requestsByEndpoint[pathname] = (this.stats.requestsByEndpoint[pathname] || 0) + 1;
            this.stats.requestsByMethod[req.method || 'UNKNOWN'] =
                (this.stats.requestsByMethod[req.method || 'UNKNOWN'] || 0) + 1;

            // Route the request
            const response = await this.routeRequest(req.method || 'GET', pathname, query, req);

            res.writeHead(200);
            res.end(JSON.stringify(response));
        } catch (error) {
            console.error('API request error:', error);

            const errorResponse: ApiResponse = {
                success: false,
                error: error instanceof Error ? error.message : 'Internal server error',
                timestamp: new Date().toISOString()
            };

            res.writeHead(500);
            res.end(JSON.stringify(errorResponse));
        }

        // Update response time stats
        const responseTime = Date.now() - startTime;
        this.requestTimes.push(responseTime);

        // Keep only last 1000 response times for average calculation
        if (this.requestTimes.length > 1000) {
            this.requestTimes.shift();
        }

        this.stats.averageResponseTime = this.requestTimes.reduce((a, b) => a + b, 0) / this.requestTimes.length;
    }

    private getBearerToken(
        req: http.IncomingMessage,
        query: Record<string, string>
    ): string | undefined {
        const authHeader = req.headers.authorization;
        if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7).trim();
            if (token) {
                return token;
            }
        }

        return query.token;
    }

    private async routeRequest(
        method: string,
        pathname: string,
        query: any,
        req: http.IncomingMessage
    ): Promise<ApiResponse> {
        const timestamp = new Date().toISOString();
        const normalizedPath = pathname === '/v1' ? '/' : pathname.startsWith('/v1/') ? pathname.slice(3) : pathname;

        switch (normalizedPath) {
            case '/':
            case '/status':
                return {
                    success: true,
                    data: {
                        service: 'CodePulse API',
                        version: '1.0.0',
                        status: 'running',
                        isTracking: this.timeTracker.getCurrentSession()?.isActive || false
                    },
                    timestamp
                };

            case '/stats':
                return this.handleStatsRequest(query, timestamp);

            case '/current':
                return this.handleCurrentSessionRequest(timestamp);

            case '/today':
                return this.handleTodayStatsRequest(timestamp);

            case '/week':
                return this.handleWeekStatsRequest(timestamp);

            case '/projects':
                return this.handleProjectsRequest(query, timestamp);

            case '/languages':
                return this.handleLanguagesRequest(query, timestamp);

            case '/sessions':
                return this.handleSessionsRequest(method, query, req, timestamp);

            case '/activities':
                return this.handleActivitiesRequest(method, query, timestamp);

            case '/export':
                return this.handleExportRequest(query, timestamp);

            case '/health':
                return this.handleHealthRequest(timestamp);

            case '/server-stats':
                return this.handleServerStatsRequest(timestamp);

            default:
                throw new Error(`Endpoint not found: ${pathname}`);
        }
    }

    private async handleStatsRequest(query: any, timestamp: string): Promise<ApiResponse> {
        const days = parseInt(query.days) || 7;
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - days);

        const sessions = await this.databaseManager.getSessionsByDateRange(startDate, endDate);
        const projectStats = await this.databaseManager.getTotalTimeByProject(startDate, endDate);
        const languageStats = await this.databaseManager.getTotalTimeByLanguage(startDate, endDate);

        return {
            success: true,
            data: {
                sessions: sessions.length,
                totalTime: sessions.reduce((sum, s) => sum + s.duration, 0),
                projects: Object.keys(projectStats).length,
                languages: Object.keys(languageStats).length,
                projectStats,
                languageStats,
                dateRange: { start: startDate.toISOString(), end: endDate.toISOString() }
            },
            timestamp
        };
    }

    private async handleCurrentSessionRequest(timestamp: string): Promise<ApiResponse> {
        const currentSession = this.timeTracker.getCurrentSession();

        return {
            success: true,
            data: currentSession || null,
            timestamp
        };
    }

    private async handleTodayStatsRequest(timestamp: string): Promise<ApiResponse> {
        const todayStats = await this.timeTracker.getTodaysStats();

        return {
            success: true,
            data: todayStats,
            timestamp
        };
    }

    private async handleWeekStatsRequest(timestamp: string): Promise<ApiResponse> {
        const weekStats = await this.timeTracker.getWeeklyStats();

        return {
            success: true,
            data: weekStats,
            timestamp
        };
    }

    private async handleProjectsRequest(query: any, timestamp: string): Promise<ApiResponse> {
        const days = parseInt(query.days) || 30;
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - days);

        const projectStats = await this.databaseManager.getTotalTimeByProject(startDate, endDate);

        return {
            success: true,
            data: projectStats,
            timestamp
        };
    }

    private async handleLanguagesRequest(query: any, timestamp: string): Promise<ApiResponse> {
        const days = parseInt(query.days) || 30;
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - days);

        const languageStats = await this.databaseManager.getTotalTimeByLanguage(startDate, endDate);

        return {
            success: true,
            data: languageStats,
            timestamp
        };
    }

    private async handleSessionsRequest(
        method: string,
        query: any,
        req: http.IncomingMessage,
        timestamp: string
    ): Promise<ApiResponse> {
        if (method === 'GET') {
            const startDate = query.start ? new Date(query.start) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const endDate = query.end ? new Date(query.end) : new Date();
            const limit = parseInt(query.limit) || 100;

            let sessions = await this.databaseManager.getSessionsByDateRange(startDate, endDate);

            // Apply limit
            if (sessions.length > limit) {
                sessions = sessions.slice(-limit);
            }

            return {
                success: true,
                data: {
                    sessions,
                    total: sessions.length,
                    dateRange: { start: startDate.toISOString(), end: endDate.toISOString() }
                },
                timestamp
            };
        }

        throw new Error(`Method ${method} not supported for /sessions`);
    }

    private async handleActivitiesRequest(method: string, query: any, timestamp: string): Promise<ApiResponse> {
        if (method !== 'GET') {
            throw new Error(`Method ${method} not supported for /activities`);
        }

        const startDate = query.start ? new Date(query.start) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const endDate = query.end ? new Date(query.end) : new Date();
        const limit = parseInt(query.limit) || 100;

        let activities = await this.databaseManager.getActivitiesByDateRange(startDate, endDate);
        if (activities.length > limit) {
            activities = activities.slice(-limit);
        }

        return {
            success: true,
            data: {
                activities,
                total: activities.length,
                dateRange: { start: startDate.toISOString(), end: endDate.toISOString() }
            },
            timestamp
        };
    }

    private async handleExportRequest(query: any, timestamp: string): Promise<ApiResponse> {
        const format = query.format || 'json';

        if (format !== 'json') {
            throw new Error('Only JSON format is currently supported');
        }

        const exportData = await this.databaseManager.exportAllData();

        return {
            success: true,
            data: exportData,
            timestamp
        };
    }

    private async handleHealthRequest(timestamp: string): Promise<ApiResponse> {
        const currentSession = this.timeTracker.getCurrentSession();

        return {
            success: true,
            data: {
                status: 'healthy',
                tracking: currentSession?.isActive || false,
                database: 'connected', // Simplified check
                uptime: Date.now() - this.stats.startTime.getTime(),
                version: '1.0.0'
            },
            timestamp
        };
    }

    private async handleServerStatsRequest(timestamp: string): Promise<ApiResponse> {
        return {
            success: true,
            data: this.getStats(),
            timestamp
        };
    }
}
