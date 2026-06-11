import { PROTOCOL_VERSION } from '@codepulse/protocol';

export const DAEMON_VERSION = '0.1.0';

/**
 * Open AI sessions whose last activity is older than this are closed by the
 * startup sweep — heals process sessions orphaned by a daemon crash.
 */
export const STALE_AI_SESSION_SWEEP_MINUTES = 10;

/**
 * Hard ceiling on the bytes a single request body may buffer. Even though every
 * POST is auth-required, a token holder or compromised local process could
 * stream an unbounded body and OOM the daemon — so the shared body reader
 * aborts with HTTP 413 once this limit is exceeded.
 */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Upper clamp on the per-day fan-out of /v1/ai/tokens. Mirrors the 90-day
 * ceiling that /v1/ai/activity and /v1/sessions already enforce so one request
 * cannot fan out unbounded sequential per-day queries.
 */
export const AI_TOKENS_MAX_DAYS = 90;

export const HTTP_ENDPOINTS = [
    '/v1/health',
    '/v1/status',
    '/v1/capabilities',
    '/v1/registry',
    '/v1/metrics',
    '/v1/bootstrap',
    '/v1/sessions',
    '/v1/ai/sessions',
    '/v1/ai/activity',
    '/v1/ai/tokens',
    '/v1/snapshots',
    '/v1/snapshots/:id/restore',
    '/v1/events/ingest'
] as const;

export const SUPPORTED_WS_EVENTS = [
    'session.started',
    'session.updated',
    'session.ended',
    'ai.tool.detected',
    'ai.session.started',
    'ai.session.updated',
    'ai.session.ended',
    'ai.tokens',
    'file.snapshot',
    'file.change',
    'recovery.action',
    'registry.updated',
    'scanner.quarantined',
    'client.connected'
] as const;

export interface DaemonCapabilities {
    version: string;
    protocol: string;
    features: string[];
    http: {
        port: number;
        endpoints: string[];
    };
    websocket: {
        port: number;
        events: string[];
    };
    spool: {
        path: string;
        supported: boolean;
    };
    registry: {
        supported: boolean;
    };
}

export const PROTOCOL = PROTOCOL_VERSION;