import * as path from 'path';
import Mocha = require('mocha');

const globModule = require('glob') as {
    glob: (pattern: string, options: { cwd: string }) => Promise<string[]>;
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
        globModule.glob('**/**.test.js', { cwd: testsRoot })
            .then((files) => {
                // Add files to the test suite
                files.forEach((file: string) => mocha.addFile(path.resolve(testsRoot, file)));

                try {
                    // Run the mocha test
                    mocha.run((failures: number) => {
                        if (failures > 0) {
                            e(new Error(`${failures} tests failed.`));
                        } else {
                            c();
                        }
                    });
                } catch (err: unknown) {
                    console.error(err);
                    e(err);
                }
            })
            .catch((err: unknown) => {
                console.error('Error finding test files:', err);
                e(err);
            });
    });
}
