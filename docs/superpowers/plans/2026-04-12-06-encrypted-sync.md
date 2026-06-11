# Encrypted Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypt every snapshot client-side with AES-256-GCM before any provider uploads it. Even the cloud provider (Google Drive, Dropbox, etc.) sees only ciphertext.

**Architecture:** A thin `SnapshotCipher` module wraps/unwraps JSON with AES-GCM. A passphrase from config is stretched to a 32-byte key using PBKDF2-SHA256 (100k iterations, random 16-byte salt per encryption). The wrapped format is a base64-encoded envelope `{ v, salt, iv, ct, tag }` serialized as JSON. `SyncManager` calls the cipher before `provider.upload` and after `provider.download`.

**Tech Stack:** Node built-in `crypto` module. No new dependencies.

---

## Files

- **Create:** `src/storage/sync/SnapshotCipher.ts` — encrypt/decrypt (~70 lines)
- **Create:** `test/suite/snapshotCipher.test.ts` — round-trip + wrong-passphrase tests
- **Modify:** `src/storage/sync/SyncManager.ts` — wrap/unwrap at upload/download boundaries
- **Modify:** `package.json` — config key for passphrase + enabled flag

---

### Task 1: Config keys

**Files:** Modify `package.json`

- [ ] **Step 1: Add config**

```json
"codepulse.sync.encryption.enabled": {
    "type": "boolean",
    "default": false,
    "description": "Encrypt snapshots client-side before uploading to the cloud provider"
},
"codepulse.sync.encryption.passphrase": {
    "type": "string",
    "default": "",
    "description": "Passphrase used to derive the AES-256 encryption key. If you change this, existing encrypted snapshots cannot be decrypted."
}
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "feat: add encrypted-sync config keys"
```

---

### Task 2: SnapshotCipher round-trip with tests

**Files:** Create `src/storage/sync/SnapshotCipher.ts`, `test/suite/snapshotCipher.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/suite/snapshotCipher.test.ts`:

```typescript
import * as assert from 'assert';
import { SnapshotCipher } from '../../src/storage/sync/SnapshotCipher';

suite('SnapshotCipher', () => {
    test('round-trips JSON payload with correct passphrase', () => {
        const cipher = new SnapshotCipher('correct horse battery staple');
        const original = { hello: 'world', n: 42, arr: [1, 2, 3] };
        const wrapped = cipher.encrypt(original);
        assert.ok(typeof wrapped === 'string');
        assert.ok(wrapped.length > 0);
        const back = cipher.decrypt(wrapped);
        assert.deepStrictEqual(back, original);
    });

    test('wrong passphrase throws', () => {
        const a = new SnapshotCipher('alpha');
        const b = new SnapshotCipher('beta');
        const wrapped = a.encrypt({ secret: 'data' });
        assert.throws(() => b.decrypt(wrapped));
    });

    test('tampered ciphertext throws', () => {
        const cipher = new SnapshotCipher('secret');
        const wrapped = cipher.encrypt({ x: 1 });
        const parsed = JSON.parse(wrapped);
        parsed.ct = parsed.ct.slice(0, -2) + 'AA'; // corrupt last bytes
        const tampered = JSON.stringify(parsed);
        assert.throws(() => cipher.decrypt(tampered));
    });

    test('isEncrypted detects envelope', () => {
        const cipher = new SnapshotCipher('k');
        const wrapped = cipher.encrypt({ a: 1 });
        assert.ok(SnapshotCipher.isEncrypted(wrapped));
        assert.ok(!SnapshotCipher.isEncrypted(JSON.stringify({ a: 1 })));
        assert.ok(!SnapshotCipher.isEncrypted('not json at all'));
    });
});
```

- [ ] **Step 2: Run tests, verify fail**

Run: `npm run compile 2>&1 | tail -3`
Expected: TS error — SnapshotCipher not found.

- [ ] **Step 3: Implement SnapshotCipher**

Create `src/storage/sync/SnapshotCipher.ts`:

```typescript
import * as crypto from 'crypto';

interface EncryptedEnvelope {
    v: 1;
    salt: string;  // base64, 16 bytes
    iv: string;    // base64, 12 bytes
    ct: string;    // base64, ciphertext
    tag: string;   // base64, 16 bytes auth tag
}

export class SnapshotCipher {
    private static readonly KEY_LEN = 32;        // AES-256
    private static readonly SALT_LEN = 16;
    private static readonly IV_LEN = 12;         // GCM standard
    private static readonly ITERATIONS = 100_000;

    constructor(private passphrase: string) {
        if (!passphrase) throw new Error('SnapshotCipher: passphrase must be non-empty');
    }

    encrypt(payload: unknown): string {
        const salt = crypto.randomBytes(SnapshotCipher.SALT_LEN);
        const iv = crypto.randomBytes(SnapshotCipher.IV_LEN);
        const key = crypto.pbkdf2Sync(
            this.passphrase, salt, SnapshotCipher.ITERATIONS, SnapshotCipher.KEY_LEN, 'sha256'
        );
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
        const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();

        const envelope: EncryptedEnvelope = {
            v: 1,
            salt: salt.toString('base64'),
            iv: iv.toString('base64'),
            ct: ct.toString('base64'),
            tag: tag.toString('base64')
        };
        return JSON.stringify(envelope);
    }

    decrypt(wrapped: string): unknown {
        const env = JSON.parse(wrapped) as EncryptedEnvelope;
        if (env.v !== 1) throw new Error(`Unsupported envelope version: ${env.v}`);
        const salt = Buffer.from(env.salt, 'base64');
        const iv = Buffer.from(env.iv, 'base64');
        const ct = Buffer.from(env.ct, 'base64');
        const tag = Buffer.from(env.tag, 'base64');

        const key = crypto.pbkdf2Sync(
            this.passphrase, salt, SnapshotCipher.ITERATIONS, SnapshotCipher.KEY_LEN, 'sha256'
        );
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return JSON.parse(pt.toString('utf8'));
    }

    static isEncrypted(raw: string): boolean {
        try {
            const obj = JSON.parse(raw);
            return obj && obj.v === 1 && typeof obj.salt === 'string'
                && typeof obj.iv === 'string' && typeof obj.ct === 'string'
                && typeof obj.tag === 'string';
        } catch {
            return false;
        }
    }
}
```

- [ ] **Step 4: Run tests**

Run: `npm run compile && node ./out/test/runTest.js 2>&1 | grep -E "(passing|failing|Cipher)"`
Expected: `4 passing`.

- [ ] **Step 5: Commit**

```bash
git add src/storage/sync/SnapshotCipher.ts test/suite/snapshotCipher.test.ts
git commit -m "feat: add AES-GCM SnapshotCipher for client-side encryption"
```

---

### Task 3: Hook into SyncManager

**Files:** Modify `src/storage/sync/SyncManager.ts`

- [ ] **Step 1: Import + cipher instance**

Add at the top:

```typescript
import { SnapshotCipher } from './SnapshotCipher';
```

In `SyncManager`, add a helper:

```typescript
private getCipher(): SnapshotCipher | undefined {
    if (!this.configManager.get<boolean>('sync.encryption.enabled', false)) return undefined;
    const pass = this.configManager.get<string>('sync.encryption.passphrase', '');
    if (!pass) {
        this.logger.warn('Encryption enabled but passphrase is empty — skipping');
        return undefined;
    }
    return new SnapshotCipher(pass);
}
```

- [ ] **Step 2: Wrap uploads**

Find `pushSnapshot()`. Replace:

```typescript
const snapshot = await this.buildLocalSnapshot();
const result = await this.provider.upload(snapshot);
```

With:

```typescript
const snapshot = await this.buildLocalSnapshot();
const cipher = this.getCipher();
const payload = cipher
    ? ({ version: snapshot.version, deviceId: snapshot.deviceId, updatedAt: snapshot.updatedAt,
         encrypted: cipher.encrypt(snapshot), sessions: [], activities: [], segments: [], dailyRollups: [] })
    : snapshot;
const result = await this.provider.upload(payload as typeof snapshot);
```

The trick: providers serialize the whole `SyncSnapshot` as JSON. If we put the ciphertext in the `encrypted` field and leave the other arrays empty, untrusted providers see only metadata + opaque blob.

- [ ] **Step 3: Unwrap downloads**

Find `pullAndMerge()`. Replace:

```typescript
const merged = await this.databaseManager.mergeSnapshot(result.snapshot);
```

With:

```typescript
let snapshot = result.snapshot;
const rawEncrypted = (snapshot as unknown as { encrypted?: string }).encrypted;
if (rawEncrypted) {
    const cipher = this.getCipher();
    if (!cipher) {
        this.logger.warn('Remote snapshot is encrypted but no passphrase configured — skipping merge');
        return;
    }
    try {
        snapshot = cipher.decrypt(rawEncrypted) as typeof snapshot;
    } catch (err) {
        this.logger.error('Failed to decrypt remote snapshot — wrong passphrase?',
            err instanceof Error ? err : new Error(String(err)));
        return;
    }
}
const merged = await this.databaseManager.mergeSnapshot(snapshot);
```

- [ ] **Step 4: Extend SyncSnapshot type**

In `src/storage/sync/SyncProvider.ts`, add optional field to `SyncSnapshot`:

```typescript
export interface SyncSnapshot {
    version: string;
    deviceId: string;
    updatedAt: string;
    sessions: unknown[];
    activities: unknown[];
    segments: unknown[];
    dailyRollups: unknown[];
    /** When encryption is enabled, the plaintext snapshot is serialized here as ciphertext
     *  and the other arrays are left empty. */
    encrypted?: string;
}
```

- [ ] **Step 5: Compile & commit**

```bash
npm run compile
git add src/storage/sync/SyncManager.ts src/storage/sync/SyncProvider.ts
git commit -m "feat: encrypt snapshots before upload, decrypt on download"
```

---

### Task 4: Integration test — encrypted round-trip through CustomRestProvider

**Files:** `test/suite/snapshotCipher.test.ts` (extend)

- [ ] **Step 1: Add integration test using a mocked provider**

```typescript
import { SyncProvider, SyncSnapshot, SyncResult } from '../../src/storage/sync/SyncProvider';
import { SnapshotCipher } from '../../src/storage/sync/SnapshotCipher';

class MemoryProvider implements SyncProvider {
    readonly name = 'Memory';
    public stored?: SyncSnapshot;
    async upload(snapshot: SyncSnapshot): Promise<SyncResult> {
        // Simulate provider round-tripping through JSON (as all real providers do)
        this.stored = JSON.parse(JSON.stringify(snapshot));
        return { success: true };
    }
    async download(): Promise<SyncResult> {
        return { success: true, snapshot: this.stored };
    }
    async test(): Promise<SyncResult> { return { success: true }; }
}

suite('Encrypted sync round-trip', () => {
    test('provider only sees ciphertext', async () => {
        const mem = new MemoryProvider();
        const cipher = new SnapshotCipher('top-secret');

        const original: SyncSnapshot = {
            version: '1.0.0', deviceId: 'dev-a', updatedAt: new Date().toISOString(),
            sessions: [{ id: 's1' }], activities: [], segments: [], dailyRollups: []
        };
        const payload: SyncSnapshot = {
            version: original.version, deviceId: original.deviceId, updatedAt: original.updatedAt,
            sessions: [], activities: [], segments: [], dailyRollups: [],
            encrypted: cipher.encrypt(original)
        };

        await mem.upload(payload);
        assert.ok(mem.stored);
        assert.strictEqual(mem.stored.sessions.length, 0);
        assert.ok(mem.stored.encrypted);

        const downloaded = await mem.download();
        const plaintext = cipher.decrypt(downloaded.snapshot!.encrypted!) as SyncSnapshot;
        assert.deepStrictEqual(plaintext.sessions, [{ id: 's1' }]);
    });
});
```

- [ ] **Step 2: Run tests**

Run: `npm run compile && node ./out/test/runTest.js 2>&1 | grep -E "(passing|failing|Encrypt|Cipher)"`
Expected: `5 passing` in cipher suites.

- [ ] **Step 3: Commit**

```bash
git add test/suite/snapshotCipher.test.ts
git commit -m "test: verify encrypted payload round-trips through provider"
```

---

### Task 5: Warn user if passphrase changes after data uploaded

**Files:** Modify `src/storage/sync/SyncManager.ts`

- [ ] **Step 1: Hash-cache passphrase fingerprint**

In `SyncManager.initialize()`, after the cipher is built:

```typescript
const cipher = this.getCipher();
if (cipher) {
    const fp = require('crypto').createHash('sha256').update(
        this.configManager.get<string>('sync.encryption.passphrase', '')
    ).digest('hex').slice(0, 16);
    const lastFp = this.context.globalState.get<string>('codepulse.sync.passphraseFingerprint');
    if (lastFp && lastFp !== fp) {
        void vscode.window.showWarningMessage(
            'Code Pulse: encryption passphrase changed. Existing cloud snapshots cannot be decrypted with the new passphrase.',
            'Got it'
        );
    }
    await this.context.globalState.update('codepulse.sync.passphraseFingerprint', fp);
}
```

- [ ] **Step 2: Add vscode import if not already there**

`import * as vscode from 'vscode';` at top of SyncManager.

- [ ] **Step 3: Compile & commit**

```bash
npm run compile
git add src/storage/sync/SyncManager.ts
git commit -m "feat: warn on passphrase change"
```

---

### Task 6: Document in README or feature docs

**Files:** Modify `CHANGELOG.md`

- [ ] **Step 1: Add changelog entry**

Under `## [Unreleased]` → `### Added`:

```
- Client-side AES-256-GCM encryption for cloud snapshots (opt-in via `codepulse.sync.encryption.enabled`)
```

Under `### Security`:

```
- When encryption is enabled, cloud providers see only opaque ciphertext; all plaintext session data remains client-side.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: note encrypted-sync in changelog"
```

---

## Out of scope

- Recovery mechanism for lost passphrase (by design — zero-knowledge).
- Key rotation flow (future).
- Separate per-provider keys.

## Self-review

Spec: client-side AES-GCM ✓, passphrase → key derivation ✓, random salt/iv per snapshot ✓, providers see only ciphertext ✓, wrong passphrase detected ✓, tamper detection via GCM auth tag ✓. Round-trip tested. No new runtime dependencies.
