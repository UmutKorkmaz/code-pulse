#!/usr/bin/env node
/**
 * Dev signing tool for Code Pulse scanner manifests.
 *
 * Generates an ed25519 keypair (persisted to scripts/.signing-key.pem, gitignored)
 * if none exists, then signs every manifest in platform/registry-catalog/.
 *
 * The content hash matches manifestContentHash() in
 * packages/registry/src/signature.ts: sha256 over JSON.stringify of the manifest
 * with the `signature` and `bundleHash` fields removed (original key order kept).
 *
 * The public key produced here is pinned as MANIFEST_SIGNING_PUBLIC_KEY in
 * packages/registry/src/signature.ts. Rotating the private key requires updating
 * that constant; this script prints the current public key on every run.
 *
 * Usage: node platform/scripts/sign-manifests.mjs
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
} from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = dirname(SCRIPT_DIR);
const KEY_PATH = join(SCRIPT_DIR, '.signing-key.pem');
const CATALOG_DIR = join(PLATFORM_DIR, 'registry-catalog');
const GITIGNORE_PATH = join(PLATFORM_DIR, '.gitignore');
const GITIGNORE_ENTRY = 'scripts/.signing-key.pem';

/**
 * Canonical content hash: drop signature + bundleHash, then sha256 over
 * JSON.stringify of the remaining fields (original insertion order preserved).
 * Must stay byte-for-byte aligned with manifestContentHash() in signature.ts.
 */
function manifestContentHash(manifest) {
  const { signature: _signature, bundleHash: _bundleHash, ...rest } = manifest;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

function ensureKeyPair() {
  if (existsSync(KEY_PATH)) {
    return;
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(KEY_PATH, pem, { mode: 0o600 });
  console.log(`[sign] generated new ed25519 private key at ${KEY_PATH}`);
}

function ensureGitignore() {
  let existing = '';
  if (existsSync(GITIGNORE_PATH)) {
    existing = readFileSync(GITIGNORE_PATH, 'utf8');
    const alreadyIgnored = existing
      .split('\n')
      .some((line) => line.trim() === GITIGNORE_ENTRY);
    if (alreadyIgnored) {
      return;
    }
  }
  const prefix = existing.length > 0 ? existing.replace(/\n?$/, '\n') : '';
  writeFileSync(
    GITIGNORE_PATH,
    `${prefix}# Local dev manifest signing key (never commit)\n${GITIGNORE_ENTRY}\n`
  );
  console.log(`[sign] ensured ${GITIGNORE_ENTRY} is ignored in ${GITIGNORE_PATH}`);
}

function main() {
  ensureKeyPair();
  ensureGitignore();

  const privateKeyPem = readFileSync(KEY_PATH, 'utf8');
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' })
    .toString();

  const files = readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    console.error(`[sign] no manifests found in ${CATALOG_DIR}`);
    process.exit(1);
  }

  for (const file of files) {
    const filePath = join(CATALOG_DIR, file);
    const manifest = JSON.parse(readFileSync(filePath, 'utf8'));

    // Strip any prior signing fields so the hash covers content only.
    delete manifest.signature;
    delete manifest.bundleHash;

    const bundleHash = manifestContentHash(manifest);
    const signature = edSign(
      null,
      Buffer.from(bundleHash, 'utf8'),
      privateKey
    ).toString('base64');

    const signed = { ...manifest, signature, bundleHash };
    writeFileSync(filePath, `${JSON.stringify(signed, null, 2)}\n`);
    console.log(`[sign] signed ${file} (bundleHash=${bundleHash.slice(0, 12)}...)`);
  }

  console.log(`\n[sign] PUBLIC KEY (pin as MANIFEST_SIGNING_PUBLIC_KEY in signature.ts):\n`);
  console.log(publicKeyPem);
}

main();
