import * as path from 'path';
import Mocha = require('mocha');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const globModule = require('glob') as {
    sync: (pattern: string, options: { cwd: string }) => string[];
};

export function run(): Promise<void> {
    // Create the mocha test
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 10000,
        reporter: 'spec'
    });

    const testsRoot = path.resolve(__dirname, '..');

    return new Promise((c, e) => {
        try {
            const files = globModule.sync('**/**.test.js', { cwd: testsRoot });

            files.forEach((file: string) => mocha.addFile(path.resolve(testsRoot, file)));

            mocha.run((failures: number) => {
                if (failures > 0) {
                    e(new Error(`${failures} tests failed.`));
                } else {
                    c();
                }
            });
        } catch (err: unknown) {
            console.error('Error finding or running test files:', err);
            e(err);
        }
    });
}
