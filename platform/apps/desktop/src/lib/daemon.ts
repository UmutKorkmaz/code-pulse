import {
    createBrowserDaemonClient,
    DEFAULT_DAEMON_HOST,
    DEFAULT_DAEMON_PORT,
    type AiActivityRow,
    type AiSession,
    type BrowserDaemonClient,
    type CodingSessionSummary,
    type DaemonStatus,
    type FileSnapshot,
    type PingResult,
    type RegistryList,
    type RegistryScanner,
    type RestoreSnapshotResult,
    type TokenAggregate
} from '@codepulse/client/browser';

const SNAPSHOT_SESSION_LIMIT = 200;
const SNAPSHOT_AI_SESSION_LIMIT = 50;

export interface DaemonSnapshot {
    baseUrl: string;
    status: DaemonStatus | null;
    tokens: TokenAggregate[];
    /** Today's per-tool AI run/active time rows (all time fields in ms). */
    aiActivity: AiActivityRow[];
    /** Today's human coding sessions (duration is seconds at this layer). */
    sessions: CodingSessionSummary[];
    /** Recent AI sessions, used for running-now detection. */
    aiSessions: AiSession[];
    error?: string;
}

function getClient(): BrowserDaemonClient {
    const host = import.meta.env.VITE_DAEMON_HOST || DEFAULT_DAEMON_HOST;
    const port = import.meta.env.VITE_DAEMON_PORT
        ? Number(import.meta.env.VITE_DAEMON_PORT)
        : DEFAULT_DAEMON_PORT;
    const token = import.meta.env.VITE_DAEMON_TOKEN as string | undefined;

    return createBrowserDaemonClient({
        host,
        port,
        ...(token ? { token } : {})
    });
}

/**
 * Fetch daemon status from GET /v1/status.
 */
export async function fetchDaemonStatus(): Promise<DaemonStatus> {
    return getClient().getStatus();
}

/**
 * Fetch AI token aggregates from GET /v1/ai/tokens (today).
 */
export async function fetchAiTokens(): Promise<TokenAggregate[]> {
    return getClient().getTodayTokens();
}

/**
 * Fetch per-day AI run/active time aggregates from GET /v1/ai/activity.
 * All time fields in the returned rows are milliseconds.
 */
export async function fetchAiActivity(days = 7): Promise<AiActivityRow[]> {
    const data = await getClient().fetchAiActivity(days);
    return data.activity ?? [];
}

/**
 * Convenience loader for the home dashboard.
 */
export async function loadDaemonSnapshot(): Promise<DaemonSnapshot> {
    const client = getClient();
    const baseUrl = client.getBaseUrl();

    try {
        const [status, tokens, aiActivityData, sessionsData, aiSessionsData] = await Promise.all([
            client.getStatus(),
            client.getTodayTokens(),
            client.fetchAiActivity(1),
            client.fetchSessions(1, SNAPSHOT_SESSION_LIMIT),
            client.getAiSessions(SNAPSHOT_AI_SESSION_LIMIT)
        ]);

        return {
            baseUrl,
            status,
            tokens,
            aiActivity: aiActivityData.activity ?? [],
            sessions: sessionsData.sessions ?? [],
            aiSessions: aiSessionsData.sessions ?? []
        };
    } catch (error) {
        return {
            baseUrl,
            status: null,
            tokens: [],
            aiActivity: [],
            sessions: [],
            aiSessions: [],
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export async function pingDaemon(): Promise<PingResult> {
    return getClient().ping();
}

export type SnapshotRow = FileSnapshot;
export type RestorePreview = RestoreSnapshotResult;
export type RegistryScannerRow = RegistryScanner;
export type CodingSessionRow = CodingSessionSummary;
export type AiSessionRow = AiSession;
export type AiActivityDayRow = AiActivityRow;

/**
 * Fetch coding sessions from GET /v1/sessions.
 */
export async function fetchSessions(days = 7, limit = 200): Promise<CodingSessionRow[]> {
    const data = await getClient().fetchSessions(days, limit);
    return data.sessions ?? [];
}

/**
 * Fetch AI sessions from GET /v1/ai/sessions.
 */
export async function fetchAiSessions(limit = 200): Promise<AiSessionRow[]> {
    const data = await getClient().getAiSessions(limit);
    return data.sessions ?? [];
}

export async function fetchSnapshots(limit = 50): Promise<SnapshotRow[]> {
    return getClient().listSnapshots(limit);
}

export async function restoreSnapshotDryRun(snapshotId: string): Promise<RestorePreview> {
    return getClient().restoreSnapshotDryRun(snapshotId);
}

export async function restoreSnapshotConfirmed(
    snapshotId: string,
    recoveryToken: string
): Promise<RestorePreview> {
    return getClient().restoreSnapshotConfirmed(snapshotId, recoveryToken);
}

export async function fetchRegistry(): Promise<RegistryList> {
    return getClient().getRegistry();
}