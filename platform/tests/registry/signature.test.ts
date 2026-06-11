import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    verifyManifestSignature,
    type ScannerManifest
} from '@codepulse/registry';

const catalogDir = path.join(process.cwd(), 'registry-catalog');

function loadSignedManifest(file: string): ScannerManifest {
    const raw = fs.readFileSync(path.join(catalogDir, file), 'utf8');
    return JSON.parse(raw) as ScannerManifest;
}

describe('registry manifest ed25519 verification', () => {
    const unsignedOfficial: ScannerManifest = {
        id: 'scn.test',
        version: '1.0.0',
        displayName: 'Test',
        publisher: 'code-pulse-official',
        trust: 'official',
        capabilities: ['process']
    };

    it('accepts a validly signed official manifest from the catalog', () => {
        const manifest = loadSignedManifest('scn.claude-code.json');
        assert.ok(manifest.signature, 'catalog manifest should be signed');

        const result = verifyManifestSignature(manifest);
        assert.strictEqual(result.ok, true, result.reason);
        assert.strictEqual(result.skipped, undefined);
    });

    it('rejects a signed manifest whose content was tampered with', () => {
        const manifest = loadSignedManifest('scn.claude-code.json');
        // Mutate a signed field; the content hash no longer matches the signature.
        const tampered: ScannerManifest = {
            ...manifest,
            processPatterns: ['evil', 'tail-anything']
        };

        const result = verifyManifestSignature(tampered);
        assert.strictEqual(result.ok, false);
    });

    it('rejects a signed manifest with a forged/garbage signature', () => {
        const manifest = loadSignedManifest('scn.claude-code.json');
        const forged: ScannerManifest = {
            ...manifest,
            signature: Buffer.from('not-a-real-signature').toString('base64')
        };

        const result = verifyManifestSignature(forged);
        assert.strictEqual(result.ok, false);
    });

    it('accepts an unsigned community manifest but marks it untrusted', () => {
        const result = verifyManifestSignature({
            ...unsignedOfficial,
            trust: 'community'
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.skipped, true);
    });

    it('rejects an unsigned official manifest', () => {
        const result = verifyManifestSignature(unsignedOfficial);
        assert.strictEqual(result.ok, false);
    });

    it('rejects an unsigned verified manifest', () => {
        const result = verifyManifestSignature({
            ...unsignedOfficial,
            trust: 'verified'
        });
        assert.strictEqual(result.ok, false);
    });
});
