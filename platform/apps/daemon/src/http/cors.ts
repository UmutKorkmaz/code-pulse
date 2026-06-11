import * as crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

const ALLOWED_ORIGIN_PATTERNS = [
    /^http:\/\/localhost(?::\d+)?$/,
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/,
    /^tauri:\/\/localhost$/,
    /^https:\/\/tauri\.localhost$/,
    // Windows Tauri (existing builds without useHttpsScheme) serves http://tauri.localhost.
    /^http:\/\/tauri\.localhost$/
];

/**
 * Loopback host names/addresses accepted in the Host header. Anything else is a
 * DNS-rebinding attempt (a public DNS name resolving to 127.0.0.1) and must be
 * rejected before routing. An optional port suffix is allowed.
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
export function isLoopbackHost(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host || typeof host !== 'string') {
        return false;
    }
    return ALLOWED_HOST_PATTERNS.some(pattern => pattern.test(host));
}

export function resolveAllowedOrigin(req: IncomingMessage): string | null {
    const origin = req.headers.origin;
    if (!origin || typeof origin !== 'string') {
        return null;
    }
    return ALLOWED_ORIGIN_PATTERNS.some(pattern => pattern.test(origin)) ? origin : null;
}

export function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
    const allowed = resolveAllowedOrigin(req);
    if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', allowed);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/** Length-checked, constant-time string comparison for bearer tokens. */
export function timingSafeEqualString(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');
    if (bufferA.length !== bufferB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufferA, bufferB);
}