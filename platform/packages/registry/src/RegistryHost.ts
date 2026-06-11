import path from 'path';
import { Worker } from 'worker_threads';

import type { LocalRegistry } from './LocalRegistry';
import { resolveParser } from './parsers';
import type {
  ParsedLogEvent,
  RegistryHostOptions,
  SandboxWorkerRequest,
  SandboxWorkerResponse,
  ScanContext,
  ScanResult,
} from './types';

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MAX_OLD_GENERATION_MB = 64;

export class RegistryHost {
  private readonly timeoutMs: number;
  private readonly workerResourceLimits: {
    maxOldGenerationSizeMb: number;
  };

  constructor(
    private readonly registry: LocalRegistry,
    options: RegistryHostOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workerResourceLimits = {
      maxOldGenerationSizeMb:
        options.workerResourceLimits?.maxOldGenerationSizeMb ??
        DEFAULT_MAX_OLD_GENERATION_MB,
    };
  }

  async scan(scannerId: string, ctx: ScanContext): Promise<ScanResult> {
    const manifest = this.registry.getManifest(scannerId);
    if (!manifest) {
      throw new Error(`Scanner not found: ${scannerId}`);
    }

    const response = await this.runInSandbox<SandboxWorkerResponse>({
      kind: 'scan',
      manifest,
      ctx,
    });

    if (!response.ok || !response.result) {
      throw new Error(response.error ?? `Scanner ${scannerId} failed`);
    }

    return response.result as ScanResult;
  }

  async parseLogLine(
    parserId: string,
    line: string,
    options: { useSandbox?: boolean } = {}
  ): Promise<ParsedLogEvent | null> {
    if (!options.useSandbox) {
      return resolveParser(parserId).parseLine(line);
    }

    const response = await this.runInSandbox<SandboxWorkerResponse>({
      kind: 'parse',
      parserId,
      line,
    });

    if (!response.ok) {
      throw new Error(response.error ?? `Parser ${parserId} failed`);
    }

    return (response.result as ParsedLogEvent | null) ?? null;
  }

  async parseLogChunk(
    parserId: string,
    text: string,
    options: { useSandbox?: boolean } = {}
  ): Promise<ParsedLogEvent[]> {
    if (!options.useSandbox) {
      return resolveParser(parserId).parseChunk(text);
    }

    const events: ParsedLogEvent[] = [];
    for (const line of text.split('\n')) {
      const event = await this.parseLogLine(parserId, line, { useSandbox: true });
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  listScannerIds(): string[] {
    return this.registry.listManifests().map((manifest) => manifest.id);
  }

  private runInSandbox<T>(request: SandboxWorkerRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const workerScript = path.join(__dirname, 'sandbox-worker.js');
      const worker = new Worker(workerScript, {
        workerData: request,
        resourceLimits: {
          maxOldGenerationSizeMb: this.workerResourceLimits.maxOldGenerationSizeMb,
        },
      });

      const timer = setTimeout(() => {
        void worker.terminate();
        reject(
          new Error(
            `Scanner sandbox timeout after ${this.timeoutMs}ms (${request.kind})`
          )
        );
      }, this.timeoutMs);

      worker.once('message', (message: T) => {
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