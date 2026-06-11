"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const worker_threads_1 = require("worker_threads");
const manifestScanner_1 = require("./manifestScanner");
const parsers_1 = require("./parsers");
async function runScan(manifest, ctx) {
    try {
        const scanner = (0, manifestScanner_1.createManifestScanner)(manifest);
        const result = await scanner.match(ctx);
        return { ok: true, result };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
function runParse(parserId, line) {
    try {
        const parser = (0, parsers_1.resolveParser)(parserId);
        const result = parser.parseLine(line);
        return { ok: true, result };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
async function handleRequest(request) {
    if (request.kind === 'scan') {
        if (!request.manifest || !request.ctx) {
            return { ok: false, error: 'Scan request missing manifest or context' };
        }
        return runScan(request.manifest, request.ctx);
    }
    if (!request.parserId || request.line === undefined) {
        return { ok: false, error: 'Parse request missing parserId or line' };
    }
    return runParse(request.parserId, request.line);
}
if (worker_threads_1.parentPort) {
    void handleRequest(worker_threads_1.workerData).then((response) => {
        worker_threads_1.parentPort?.postMessage(response);
    });
}
//# sourceMappingURL=sandbox-worker.js.map