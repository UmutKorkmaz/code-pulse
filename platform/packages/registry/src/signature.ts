import { createHash, createPublicKey, verify as edVerify } from 'crypto';

import type { ScannerManifest } from './types';

export interface SignatureVerifyResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
}

/**
 * ed25519 public key for the Code Pulse manifest registry.
 *
 * Pinned to the dev signing key in platform/scripts/.signing-key.pem (gitignored).
 * Regenerating that key requires re-running platform/scripts/sign-manifests.mjs
 * and replacing this constant with the public key it prints.
 */
const MANIFEST_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALQwPY5v4ALRN2acQWn2ctrxlw+p3LCzQgQgjQAL2WDg=
-----END PUBLIC KEY-----
`;

const signingPublicKey = createPublicKey(MANIFEST_SIGNING_PUBLIC_KEY);

/**
 * Verify a scanner manifest against the registry ed25519 signing key.
 *
 * - Signed manifests pass only when the ed25519 signature verifies over the
 *   canonical content hash (manifestContentHash). A bad or forged signature fails.
 * - Unsigned manifests pass only for the 'community' trust tier, which the engine
 *   never auto-enables. Unsigned 'official'/'verified' manifests fail, so a JSON
 *   file dropped into the cache directory cannot grant itself trusted status.
 */
export function verifyManifestSignature(manifest: ScannerManifest): SignatureVerifyResult {
  if (manifest.signature) {
    const contentHash = manifestContentHash(manifest);
    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(manifest.signature, 'base64');
    } catch {
      return { ok: false, reason: 'manifest signature is not valid base64' };
    }

    let verified = false;
    try {
      verified = edVerify(
        null,
        Buffer.from(contentHash, 'utf8'),
        signingPublicKey,
        signatureBytes
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `signature verification error: ${message}` };
    }

    if (!verified) {
      return {
        ok: false,
        reason: 'ed25519 signature does not match registry signing key',
      };
    }

    return { ok: true, reason: 'ed25519 signature verified' };
  }

  if (manifest.trust === 'community') {
    return { ok: true, skipped: true, reason: 'unsigned community manifest allowed (not auto-enabled)' };
  }

  return {
    ok: false,
    reason: `unsigned manifest with trust '${manifest.trust}' rejected: only signed manifests may claim 'official'/'verified' trust`,
  };
}

export function manifestContentHash(manifest: ScannerManifest): string {
  const { signature: _signature, bundleHash: _bundleHash, ...rest } = manifest;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}
