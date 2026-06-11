import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDaemonClient } from '@codepulse/client';
import { printJson } from '../format.js';

interface CheckResult {
    name: string;
    ok: boolean;
    detail: string;
}

export async function runDoctor(json: boolean): Promise<number> {
    const client = createDaemonClient();
    const homeDir = client.getHomeDir();
    const checks: CheckResult[] = [];

    checks.push({
        name: 'data-directory',
        ok: fs.existsSync(homeDir),
        detail: fs.existsSync(homeDir) ? homeDir : `Missing ${homeDir}`
    });

    const tokenPath = path.join(homeDir, 'token');
    checks.push({
        name: 'auth-token',
        ok: client.hasToken(),
        detail: client.hasToken() ? tokenPath : `Missing optional token file at ${tokenPath}`
    });

    const dbPath = path.join(homeDir, 'codepulse.db');
    checks.push({
        name: 'database',
        ok: fs.existsSync(dbPath),
        detail: fs.existsSync(dbPath) ? dbPath : `Database not found at ${dbPath}`
    });

    const ping = await client.ping();
    checks.push({
        name: 'daemon-reachable',
        ok: ping.ok,
        detail: ping.ok
            ? `${client.getBaseUrl()} (${ping.latencyMs}ms)`
            : ping.error || 'Daemon unreachable'
    });

    if (ping.ok) {
        try {
            const status = await client.getStatus();
            checks.push({
                name: 'daemon-status',
                ok: true,
                detail: `${status.service ?? 'codepulse-d'} ${status.version ?? 'unknown'} (${status.status ?? 'ok'})`
            });
        } catch (error) {
            checks.push({
                name: 'daemon-status',
                ok: false,
                detail: error instanceof Error ? error.message : String(error)
            });
        }

        try {
            const registry = await client.getRegistry();
            const count = registry.scanners?.length ?? 0;
            checks.push({
                name: 'registry',
                ok: true,
                detail: `${count} scanner${count === 1 ? '' : 's'} installed`
            });
        } catch (error) {
            checks.push({
                name: 'registry',
                ok: false,
                detail: error instanceof Error ? error.message : String(error)
            });
        }
    }

    const failed = checks.filter(check => !check.ok);

    if (json) {
        printJson({
            ok: failed.length === 0,
            homeDir,
            daemonUrl: client.getBaseUrl(),
            checks
        });
    } else {
        console.log('Code Pulse doctor\n');
        for (const check of checks) {
            const icon = check.ok ? '✓' : '✗';
            console.log(`${icon} ${check.name}: ${check.detail}`);
        }

        console.log('');
        if (failed.length === 0) {
            console.log('All checks passed.');
        } else {
            console.log(`${failed.length} check(s) failed.`);
        }
    }

    return failed.length === 0 ? 0 : 1;
}