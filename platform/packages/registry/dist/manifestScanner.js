"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createManifestScanner = createManifestScanner;
const crypto_1 = require("crypto");
function hashEvidence(value) {
    return (0, crypto_1.createHash)('sha256').update(value).digest('hex');
}
function scoreProcessMatch(manifest, processes) {
    const patterns = manifest.processPatterns ?? [];
    if (patterns.length === 0) {
        return { score: 0, evidence: [] };
    }
    const evidence = [];
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
function scoreExtensionReports(manifest, ctx) {
    if (!manifest.capabilities.includes('extension')) {
        return { score: 0, evidence: [] };
    }
    const reports = ctx.extensionReports ?? [];
    if (reports.length === 0) {
        return { score: 0, evidence: [] };
    }
    const evidence = reports
        .filter((report) => report.active)
        .map((report) => ({
        type: 'extension_report',
        timestamp: report.timestamp,
        hash: hashEvidence(`${manifest.id}:${report.extensionId}`),
    }));
    const score = evidence.length > 0 ? 0.2 : 0;
    return { score, evidence };
}
function createManifestScanner(manifest) {
    return {
        id: manifest.id,
        version: manifest.version,
        capabilities: manifest.capabilities,
        async match(ctx) {
            const processMatch = scoreProcessMatch(manifest, ctx.processes);
            const extensionMatch = scoreExtensionReports(manifest, ctx);
            const evidence = [...processMatch.evidence, ...extensionMatch.evidence];
            const confidence = Math.min(1, processMatch.score + extensionMatch.score);
            return {
                tool: manifest.displayName,
                confidence,
                evidence,
            };
        },
    };
}
//# sourceMappingURL=manifestScanner.js.map