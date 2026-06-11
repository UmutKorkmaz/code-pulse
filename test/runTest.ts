import * as path from 'path';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

function resolveLocalVSCodeExecutable(): string | undefined {
    if (process.env.VSCODE_EXECUTABLE_PATH && fs.existsSync(process.env.VSCODE_EXECUTABLE_PATH)) {
        return process.env.VSCODE_EXECUTABLE_PATH;
    }

    if (process.platform === 'darwin') {
        const macExecutable = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
        if (fs.existsSync(macExecutable)) {
            return macExecutable;
        }
    }

    return undefined;
}

async function main() {
    try {
        // The folder containing the Extension Manifest package.json
        // Passed to `--extensionDevelopmentPath`
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');

        // The path to test runner
        // Passed to --extensionTestsPath
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        const vscodeExecutablePath = resolveLocalVSCodeExecutable();

        // Download VS Code, unzip it and run the integration test
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            vscodeExecutablePath,
            launchArgs: [
                '--disable-extensions',
                '--disable-workspace-trust'
            ]
        });
    } catch (err) {
        console.error('Failed to run tests');
        console.error(err);
        process.exit(1);
    }
}

main();
