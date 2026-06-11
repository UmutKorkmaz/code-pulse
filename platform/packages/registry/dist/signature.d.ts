import type { ScannerManifest } from './types';
export interface SignatureVerifyResult {
    ok: boolean;
    skipped?: boolean;
    reason?: string;
}
/**
 * Verify a scanner manifest against the registry ed25519 signing key.
 *
 * - Signed manifests pass only when the ed25519 signature verifies over the
 *   canonical content hash (manifestContentHash). A bad or forged signature fails.
 * - Unsigned manifests pass only for the 'community' trust tier, which the engine
 *   never auto-enables. Unsigned 'official'/'verified' manifests fail, so a JSON
 *   file dropped into the cache directory cannot grant itself trusted status.
 */
export declare function verifyManifestSignature(manifest: ScannerManifest): SignatureVerifyResult;
export declare function manifestContentHash(manifest: ScannerManifest): string;
//# sourceMappingURL=signature.d.ts.map