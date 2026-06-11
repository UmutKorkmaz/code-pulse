"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegistryHost = void 0;
const path_1 = __importDefault(require("path"));
const worker_threads_1 = require("worker_threads");
const parsers_1 = require("./parsers");
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MAX_OLD_GENERATION_MB = 64;
class RegistryHost {
    constructor(registry, options = {}) {
        this.registry = registry;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.workerResourceLimits = {
            maxOldGenerationSizeMb: options.workerResourceLimits?.maxOldGenerationSizeMb ??
                DEFAULT_MAX_OLD_GENERATION_MB,
        };
    }
    async scan(scannerId, ctx) {
        const manifest = this.registry.getManifest(scannerId);
        if (!manifest) {
            throw new Error(`Scanner not found: ${scannerId}`);
        }
        const response = await this.runInSandbox({
            kind: 'scan',
            manifest,
            ctx,
        });
        if (!response.ok || !response.result) {
            throw new Error(response.error ?? `Scanner ${scannerId} failed`);
        }
        return response.result;
    }
    async parseLogLine(parserId, line, options = {}) {
        if (!options.useSandbox) {
            return (0, parsers_1.resolveParser)(parserId).parseLine(line);
        }
        const response = await this.runInSandbox({
            kind: 'parse',
            parserId,
            line,
        });
        if (!response.ok) {
            throw new Error(response.error ?? `Parser ${parserId} failed`);
        }
        return response.result ?? null;
    }
    async parseLogChunk(parserId, text, options = {}) {
        if (!options.useSandbox) {
            return (0, parsers_1.resolveParser)(parserId).parseChunk(text);
        }
        const events = [];
        for (const line of text.split('\n')) {
            const event = await this.parseLogLine(parserId, line, { useSandbox: true });
            if (event) {
                events.push(event);
            }
        }
        return events;
    }
    listScannerIds() {
        return this.registry.listManifests().map((manifest) => manifest.id);
    }
    runInSandbox(request) {
        return new Promise((resolve, reject) => {
            const workerScript = path_1.default.join(__dirname, 'sandbox-worker.js');
            const worker = new worker_threads_1.Worker(workerScript, {
                workerData: request,
                resourceLimits: {
                    maxOldGenerationSizeMb: this.workerResourceLimits.maxOldGenerationSizeMb,
                },
            });
            const timer = setTimeout(() => {
                void worker.terminate();
                reject(new Error(`Scanner sandbox timeout after ${this.timeoutMs}ms (${request.kind})`));
            }, this.timeoutMs);
            worker.once('message', (message) => {
                clearTimeout(timer);
                resolve(message);
            });
            worker.once('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            worker.once('exit', (code) => {
                clearTimeout(timer);
                if (code !== 0) {
                    reject(new Error(`Scanner sandbox exited with code ${code}`));
                }
            });
        });
    }
}
exports.RegistryHost = RegistryHost;
//# sourceMappingURL=RegistryHost.js.map