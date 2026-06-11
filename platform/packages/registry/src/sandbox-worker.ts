import { parentPort, workerData } from 'worker_threads';

import { createManifestScanner } from './manifestScanner';
import { resolveParser } from './parsers';
import type {
  SandboxWorkerRequest,
  SandboxWorkerResponse,
  ScanContext,
  ScannerManifest,
} from './types';

async function runScan(
  manifest: ScannerManifest,
  ctx: ScanContext
): Promise<SandboxWorkerResponse> {
  try {
    const scanner = createManifestScanner(manifest);
    const result = await scanner.match(ctx);
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runParse(parserId: string, line: string): SandboxWorkerResponse {
  try {
    const parser = resolveParser(parserId);
    const result = parser.parseLine(line);
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleRequest(
  request: SandboxWorkerRequest
): Promise<SandboxWorkerResponse> {
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

if (parentPort) {
  void handleRequest(workerData as SandboxWorkerRequest).then((response) => {
    parentPort?.postMessage(response);
  });
}