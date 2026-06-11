import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

// Compiled daemon scanner glob — import via relative path to dist for tests
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { expandLogGlob, expandLogGlobAsync } = require('../../../apps/daemon/dist/scanner/glob.js') as {
    expandLogGlob: (
        pattern: string,
        maxFiles?: number,
        onTruncate?: (dropped: number) => void
    ) => string[];
    expandLogGlobAsync: (
        pattern: string,
        maxFiles?: number,
        onTruncate?: (dropped: number) => void
    ) => Promise<string[]>;
};

describe('scanner glob expansion', () => {
    let tempDir = '';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-glob-exp-'));
    });

    afterEach(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('expands ~ against HOME', async () => {
        // Arrange
        const originalHome = process.env.HOME;
        fs.mkdirSync(nodePath.join(tempDir, 'logs'));
        const expected = nodePath.join(tempDir, 'logs', 'a.jsonl');
        fs.writeFileSync(expected, '{}');
        fs.writeFileSync(nodePath.join(tempDir, 'logs', 'b.txt'), 'x');

        try {
            process.env.HOME = tempDir;

            // Act
            const syncMatches = expandLogGlob('~/logs/*.jsonl');
            const asyncMatches = await expandLogGlobAsync('~/logs/*.jsonl');

            // Assert
            assert.deepStrictEqual(syncMatches, [expected]);
            assert.deepStrictEqual(asyncMatches, [expected]);
        } finally {
            process.env.HOME = originalHome;
        }
    });

    it('matches **/*.jsonl across nested directories without leaving the base dir', async () => {
        // Arrange
        const base = nodePath.join(tempDir, 'dir');
        fs.mkdirSync(nodePath.join(base, 'sessions', 'deep', 'deeper'), { recursive: true });
        fs.mkdirSync(nodePath.join(base, 'other'));
        const inside = [
            nodePath.join(base, 'sessions', 'a.jsonl'),
            nodePath.join(base, 'sessions', 'deep', 'b.jsonl'),
            nodePath.join(base, 'sessions', 'deep', 'deeper', 'c.jsonl')
        ];
        for (const filePath of inside) {
            fs.writeFileSync(filePath, '{}');
        }
        // Outside the glob base — must never match.
        fs.writeFileSync(nodePath.join(base, 'root.jsonl'), '{}');
        fs.writeFileSync(nodePath.join(base, 'other', 'd.jsonl'), '{}');

        // Act
        const matches = await expandLogGlobAsync(nodePath.join(base, 'sessions', '**', '*.jsonl'));

        // Assert
        assert.deepStrictEqual(matches, [...inside].sort());
    });

    it('does not match files in the parent of the last literal segment (baseDir regression)', async () => {
        // Arrange: 'dir/sessions/*.jsonl' must anchor at dir/sessions, so
        // dir/root.jsonl must NOT match.
        const base = nodePath.join(tempDir, 'dir');
        fs.mkdirSync(nodePath.join(base, 'sessions'), { recursive: true });
        const inside = nodePath.join(base, 'sessions', 'in.jsonl');
        fs.writeFileSync(inside, '{}');
        fs.writeFileSync(nodePath.join(base, 'root.jsonl'), '{}');

        // Act
        const syncMatches = expandLogGlob(nodePath.join(base, 'sessions', '*.jsonl'));
        const asyncMatches = await expandLogGlobAsync(nodePath.join(base, 'sessions', '*.jsonl'));

        // Assert
        assert.deepStrictEqual(syncMatches, [inside]);
        assert.deepStrictEqual(asyncMatches, [inside]);
    });

    it('caps results at maxFiles keeping the newest files by mtime deterministically', async () => {
        // Arrange: alphabetical order deliberately differs from mtime order.
        const baseSeconds = 1_700_000_000;
        const filesByAge: Array<[string, number]> = [
            ['z-old.jsonl', baseSeconds + 1],
            ['b-old.jsonl', baseSeconds + 2],
            ['c-old.jsonl', baseSeconds + 3],
            ['m-new.jsonl', baseSeconds + 4],
            ['a-newest.jsonl', baseSeconds + 5]
        ];
        for (const [name, mtime] of filesByAge) {
            const filePath = nodePath.join(tempDir, name);
            fs.writeFileSync(filePath, '{}');
            fs.utimesSync(filePath, mtime, mtime);
        }
        const expected = [
            nodePath.join(tempDir, 'a-newest.jsonl'),
            nodePath.join(tempDir, 'm-new.jsonl')
        ];

        // Act
        let syncDropped = 0;
        let asyncDropped = 0;
        const syncMatches = expandLogGlob(
            nodePath.join(tempDir, '*.jsonl'),
            2,
            dropped => {
                syncDropped = dropped;
            }
        );
        const asyncMatches = await expandLogGlobAsync(
            nodePath.join(tempDir, '*.jsonl'),
            2,
            dropped => {
                asyncDropped = dropped;
            }
        );

        // Assert
        assert.deepStrictEqual(syncMatches, expected);
        assert.deepStrictEqual(asyncMatches, expected);
        assert.strictEqual(syncDropped, 3);
        assert.strictEqual(asyncDropped, 3);
    });
});
