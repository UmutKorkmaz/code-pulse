"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isLoopbackHost = isLoopbackHost;
exports.resolveAllowedOrigin = resolveAllowedOrigin;
exports.applyCorsHeaders = applyCorsHeaders;
exports.timingSafeEqualString = timingSafeEqualString;
const crypto = __importStar(require("crypto"));
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
function isLoopbackHost(req) {
    const host = req.headers.host;
    if (!host || typeof host !== 'string') {
        return false;
    }
    return ALLOWED_HOST_PATTERNS.some(pattern => pattern.test(host));
}
function resolveAllowedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin || typeof origin !== 'string') {
        return null;
    }
    return ALLOWED_ORIGIN_PATTERNS.some(pattern => pattern.test(origin)) ? origin : null;
}
function applyCorsHeaders(req, res) {
    const allowed = resolveAllowedOrigin(req);
    if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', allowed);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
/** Length-checked, constant-time string comparison for bearer tokens. */
function timingSafeEqualString(a, b) {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');
    if (bufferA.length !== bufferB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufferA, bufferB);
}
//# sourceMappingURL=cors.js.map