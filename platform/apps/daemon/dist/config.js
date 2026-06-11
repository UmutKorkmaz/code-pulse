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
exports.loadConfig = loadConfig;
exports.ensureAuthToken = ensureAuthToken;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const core_1 = require("@codepulse/core");
const DEFAULT_HTTP_PORT = 7842;
const DEFAULT_WS_PORT = 7843;
function loadConfig(overrides = {}) {
    const dataDir = (0, core_1.expandHome)(overrides.dataDir ??
        process.env.CODEPULSE_HOME ??
        process.env.CODEPULSE_DATA_DIR ??
        (0, core_1.defaultDataDir)());
    const httpPort = overrides.httpPort ?? parsePort(process.env.CODEPULSE_HTTP_PORT, DEFAULT_HTTP_PORT);
    const wsPort = overrides.wsPort ?? parsePort(process.env.CODEPULSE_WS_PORT, DEFAULT_WS_PORT);
    const host = overrides.host ?? process.env.CODEPULSE_HOST ?? '127.0.0.1';
    (0, core_1.ensureDir)(dataDir);
    (0, core_1.ensureDir)(path.join(dataDir, 'spool'));
    (0, core_1.ensureDir)(path.join(dataDir, 'cache', 'registry'));
    return {
        dataDir,
        httpPort,
        wsPort,
        host,
        spoolPath: path.join(dataDir, 'spool', 'events.ndjson'),
        spoolCursorPath: path.join(dataDir, 'spool', 'cursor.json'),
        registryDir: path.join(dataDir, 'cache', 'registry'),
        tokenPath: path.join(dataDir, 'token'),
        pidPath: path.join(dataDir, 'daemon.pid'),
        portFilePath: path.join(dataDir, 'ports.json'),
        legacyPortFilePath: path.join(dataDir, 'port')
    };
}
function ensureAuthToken(config) {
    const existing = (0, core_1.readTextFileIfExists)(config.tokenPath)?.trim();
    if (existing) {
        return existing;
    }
    const token = generateToken();
    fs.writeFileSync(config.tokenPath, `${token}\n`, { mode: 0o600 });
    return token;
}
function parsePort(value, fallback) {
    if (!value) {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function generateToken() {
    const { randomUUID } = require('crypto');
    return randomUUID();
}
//# sourceMappingURL=config.js.map