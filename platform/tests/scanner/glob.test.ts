import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

// Compiled daemon scanner glob — import via relative path to source for tests
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { expandLogGlob } = require('../../../apps/daemon/dist/scanner/glob.js') as {
    expandLogGlob: (pattern: string) => string[];
};

describe('scanner glob', () => {
    let tempDir = '';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-glob-'));
    });

    afterEach(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('matches filename-only wildcard patterns', () => {
        fs.writeFileSync(nodePath.join(tempDir, 'alpha.log'), 'a');
        fs.writeFileSync(nodePath.join(tempDir, 'beta.txt'), 'b');

        const originalCwd = process.cwd();
        try {
            process.chdir(tempDir);
            const matches = expandLogGlob('*.log');
            assert.deepStrictEqual(
                matches.map(match => nodePath.basename(match)).sort(),
                ['alpha.log']
            );
        } finally {
            process.chdir(originalCwd);
        }
    });
});