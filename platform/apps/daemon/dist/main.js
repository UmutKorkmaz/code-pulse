#!/usr/bin/env node
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
const fs = __importStar(require("fs"));
const core_1 = require("@codepulse/core");
const config_1 = require("./config");
const constants_1 = require("./constants");
const server_1 = require("./http/server");
const metrics_1 = require("./metrics");
const tailer_1 = require("./spool/tailer");
const broadcaster_1 = require("./ws/broadcaster");
const envelope_1 = require("./envelope");
const registry_1 = require("./registry");
const engine_1 = require("./scanner/engine");
const metrics = new metrics_1.MetricsRegistry();
const startedAt = new Date();
const config = (0, config_1.loadConfig)();
const authToken = (0, config_1.ensureAuthToken)(config);
const database = new core_1.DatabaseV5(config.dataDir);
const snapshotManager = new core_1.SnapshotManager({ dataDir: config.dataDir, database });
const wsBroadcaster = new broadcaster_1.WsBroadcaster(config.wsPort, config.host, metrics, authToken);
const spoolTailer = new tailer_1.SpoolTailer({
    spoolPath: config.spoolPath,
    cursorPath: config.spoolCursorPath,
    database
}, metrics);
const httpServer = new server_1.DaemonHttpServer({
    config,
    metrics,
    wsBroadcaster,
    spoolTailer,
    snapshotManager,
    database,
    startedAt,
    authToken
});
const scannerEngine = new engine_1.ScannerEngine({
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
let staleAiSweepTimer;
async function start() {
    writePidFile();
    writePortFiles();
    (0, registry_1.seedRegistryIfEmpty)(config.registryDir);
    await snapshotManager.initialize();
    // Startup sweep: close AI sessions orphaned by a crash (no process-gone
    // event ever fired for them), so wall-clock run time stops growing.
    const staleAiSessions = await database.endStaleAiSessions(constants_1.STALE_AI_SESSION_SWEEP_MINUTES);
    console.log(`stale AI sessions closed on startup: ${staleAiSessions}`);
    // Recurring sweep: extension/terminal detectors only forward
    // ai.tool.detected envelopes and never emit ai.session.ended, so their
    // detection-only sessions would otherwise stay open for the daemon's whole
    // lifetime and report ever-growing wall-clock run time. Close any session
    // whose last activity predates the sweep window on a recurring timer.
    staleAiSweepTimer = setInterval(() => {
        void database
            .endStaleAiSessions(constants_1.STALE_AI_SESSION_SWEEP_MINUTES)
            .catch(error => console.error('[ai-sweep]', error.message));
    }, constants_1.STALE_AI_SESSION_SWEEP_MINUTES * 60_000);
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
    wsBroadcaster.broadcast((0, envelope_1.createDaemonEnvelope)({
        type: 'registry.updated',
        scanners: (0, registry_1.loadInstalledScanners)(config.registryDir)
    }));
}
async function shutdown(_reason) {
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
function writePidFile() {
    fs.writeFileSync(config.pidPath, `${process.pid}\n`, 'utf8');
}
function removePidFile() {
    try {
        fs.unlinkSync(config.pidPath);
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Failed to remove pid file:', error);
        }
    }
}
function writePortFiles() {
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
//# sourceMappingURL=main.js.map