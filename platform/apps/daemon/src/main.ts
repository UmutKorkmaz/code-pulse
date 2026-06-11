#!/usr/bin/env node
import * as fs from 'fs';
import { DatabaseV5, SnapshotManager } from '@codepulse/core';
import { loadConfig, ensureAuthToken } from './config';
import { STALE_AI_SESSION_SWEEP_MINUTES } from './constants';
import { DaemonHttpServer } from './http/server';
import { MetricsRegistry } from './metrics';
import { SpoolTailer } from './spool/tailer';
import { WsBroadcaster } from './ws/broadcaster';
import { createDaemonEnvelope } from './envelope';
import { loadInstalledScanners, seedRegistryIfEmpty } from './registry';
import { ScannerEngine } from './scanner/engine';

const metrics = new MetricsRegistry();
const startedAt = new Date();
const config = loadConfig();
const authToken = ensureAuthToken(config);
const database = new DatabaseV5(config.dataDir);
const snapshotManager = new SnapshotManager({ dataDir: config.dataDir, database });

const wsBroadcaster = new WsBroadcaster(config.wsPort, config.host, metrics, authToken);
const spoolTailer = new SpoolTailer(
    {
        spoolPath: config.spoolPath,
        cursorPath: config.spoolCursorPath,
        database
    },
    metrics
);

const httpServer = new DaemonHttpServer({
    config,
    metrics,
    wsBroadcaster,
    spoolTailer,
    snapshotManager,
    database,
    startedAt,
    authToken
});

const scannerEngine = new ScannerEngine({
    database,
    metrics,
    registryDir: config.registryDir,
    broadcast: envelope => wsBroadcaster.broadcast(envelope)
});

scannerEngine.on('error', error => {
    console.error('[scanner]', error.message);
    metrics.increment('codepulse_scanner_errors_total');
});

let shuttingDown = false;
let staleAiSweepTimer: NodeJS.Timeout | undefined;

async function start(): Promise<void> {
    writePidFile();
    writePortFiles();
    seedRegistryIfEmpty(config.registryDir);
    await snapshotManager.initialize();

    // Startup sweep: close AI sessions orphaned by a crash (no process-gone
    // event ever fired for them), so wall-clock run time stops growing.
    const staleAiSessions = await database.endStaleAiSessions(STALE_AI_SESSION_SWEEP_MINUTES);
    console.log(`stale AI sessions closed on startup: ${staleAiSessions}`);

    // Recurring sweep: extension/terminal detectors only forward
    // ai.tool.detected envelopes and never emit ai.session.ended, so their
    // detection-only sessions would otherwise stay open for the daemon's whole
    // lifetime and report ever-growing wall-clock run time. Close any session
    // whose last activity predates the sweep window on a recurring timer.
    staleAiSweepTimer = setInterval(() => {
        void database
            .endStaleAiSessions(STALE_AI_SESSION_SWEEP_MINUTES)
            .catch(error => console.error('[ai-sweep]', (error as Error).message));
    }, STALE_AI_SESSION_SWEEP_MINUTES * 60_000);
    staleAiSweepTimer.unref();

    spoolTailer.on('envelope', envelope => {
        wsBroadcaster.broadcast(envelope);
    });

    spoolTailer.on('error', error => {
        console.error('[spool]', error.message);
        metrics.increment('codepulse_spool_errors_total');
    });

    await wsBroadcaster.start();
    await httpServer.start();
    await spoolTailer.start();

    console.log(`codepulse-d listening on http://${config.host}:${config.httpPort}`);
    console.log(`codepulse-d websocket on ws://${config.host}:${config.wsPort}`);
    console.log(`data dir: ${config.dataDir}`);
    console.log(`spool: ${config.spoolPath}`);

    if (process.env.CODEPULSE_DISABLE_SCANNER !== '1') {
        setTimeout(() => {
            void scannerEngine.start().catch(error => {
                console.error('Failed to start scanner engine:', error);
                metrics.increment('codepulse_scanner_errors_total');
            });
        }, 2000);
    }

    wsBroadcaster.broadcast(
        createDaemonEnvelope({
            type: 'registry.updated',
            scanners: loadInstalledScanners(config.registryDir)
        })
    );
}

async function shutdown(_reason?: string): Promise<void> {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;

    if (staleAiSweepTimer) {
        clearInterval(staleAiSweepTimer);
        staleAiSweepTimer = undefined;
    }

    await scannerEngine.stop();
    await spoolTailer.stop();
    await httpServer.stop();
    await wsBroadcaster.stop();
    await snapshotManager.close();
    removePidFile();
}

function writePidFile(): void {
    fs.writeFileSync(config.pidPath, `${process.pid}\n`, 'utf8');
}

function removePidFile(): void {
    try {
        fs.unlinkSync(config.pidPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('Failed to remove pid file:', error);
        }
    }
}

function writePortFiles(): void {
    const payload = {
        http: config.httpPort,
        ws: config.wsPort,
        host: config.host,
        updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(config.portFilePath, JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(config.legacyPortFilePath, `${config.httpPort}\n`, 'utf8');
}

process.on('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0));
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
    void shutdown('uncaughtException').finally(() => process.exit(1));
});

start().catch(error => {
    console.error('Failed to start codepulse-d:', error);
    process.exit(1);
});