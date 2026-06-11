import { createHash } from 'crypto';

import type { Scanner } from './Scanner';
import type {
  Evidence,
  ScanContext,
  ScanResult,
  ScannerManifest,
} from './types';

function hashEvidence(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function scoreProcessMatch(
  manifest: ScannerManifest,
  processes: string[]
): { score: number; evidence: Evidence[] } {
  const patterns = manifest.processPatterns ?? [];
  if (patterns.length === 0) {
    return { score: 0, evidence: [] };
  }

  const evidence: Evidence[] = [];
  let matches = 0;

  for (const processName of processes) {
    for (const pattern of patterns) {
      if (processName.toLowerCase().includes(pattern.toLowerCase())) {
        matches += 1;
        evidence.push({
          type: 'process',
          timestamp: new Date().toISOString(),
          hash: hashEvidence(`${manifest.id}:${processName}:${pattern}`),
        });
      }
    }
  }

  const score = Math.min(0.4, matches > 0 ? 0.4 : 0);
  return { score, evidence };
}

function scoreExtensionReports(
  manifest: ScannerManifest,
  ctx: ScanContext
): { score: number; evidence: Evidence[] } {
  if (!manifest.capabilities.includes('extension')) {
    return { score: 0, evidence: [] };
  }

  const reports = ctx.extensionReports ?? [];
  if (reports.length === 0) {
    return { score: 0, evidence: [] };
  }

  const evidence: Evidence[] = reports
    .filter((report) => report.active)
    .map((report) => ({
      type: 'extension_report' as const,
      timestamp: report.timestamp,
      hash: hashEvidence(`${manifest.id}:${report.extensionId}`),
    }));

  const score = evidence.length > 0 ? 0.2 : 0;
  return { score, evidence };
}

export function createManifestScanner(manifest: ScannerManifest): Scanner {
  return {
    id: manifest.id,
    version: manifest.version,
    capabilities: manifest.capabilities,
    async match(ctx: ScanContext): Promise<ScanResult> {
      const processMatch = scoreProcessMatch(manifest, ctx.processes);
      const extensionMatch = scoreExtensionReports(manifest, ctx);

      const evidence = [...processMatch.evidence, ...extensionMatch.evidence];
      const confidence = Math.min(
        1,
        processMatch.score + extensionMatch.score
      );

      return {
        tool: manifest.displayName,
        confidence,
        evidence,
      };
    },
  };
}