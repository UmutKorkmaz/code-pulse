import * as fs from 'fs';
import * as path from 'path';
import { defaultDataDir, ensureDir, expandHome, readTextFileIfExists } from '@codepulse/core';

export interface DaemonConfig {
    dataDir: string;
    httpPort: number;
    wsPort: number;
    host: string;
    spoolPath: string;
    spoolCursorPath: string;
    registryDir: string;
    tokenPath: string;
    pidPath: string;
    portFilePath: string;
    legacyPortFilePath: string;
}

export interface DaemonConfigOverrides {
    dataDir?: string;
    httpPort?: number;
    wsPort?: number;
    host?: string;
}

const DEFAULT_HTTP_PORT = 7842;
const DEFAULT_WS_PORT = 7843;

export function loadConfig(overrides: DaemonConfigOverrides = {}): DaemonConfig {
    const dataDir = expandHome(
        overrides.dataDir ??
            process.env.CODEPULSE_HOME ??
            process.env.CODEPULSE_DATA_DIR ??
            defaultDataDir()
    );
    const httpPort = overrides.httpPort ?? parsePort(process.env.CODEPULSE_HTTP_PORT, DEFAULT_HTTP_PORT);
    const wsPort = overrides.wsPort ?? parsePort(process.env.CODEPULSE_WS_PORT, DEFAULT_WS_PORT);
    const host = overrides.host ?? process.env.CODEPULSE_HOST ?? '127.0.0.1';

    ensureDir(dataDir);
    ensureDir(path.join(dataDir, 'spool'));
    ensureDir(path.join(dataDir, 'cache', 'registry'));

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

export function ensureAuthToken(config: DaemonConfig): string {
    const existing = readTextFileIfExists(config.tokenPath)?.trim();
    if (existing) {
        return existing;
    }

    const token = generateToken();
    fs.writeFileSync(config.tokenPath, `${token}\n`, { mode: 0o600 });
    return token;
}

function parsePort(value: string | undefined, fallback: number): number {
    if (!value) {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function generateToken(): string {
    const { randomUUID } = require('crypto') as typeof import('crypto');
    return randomUUID();
}