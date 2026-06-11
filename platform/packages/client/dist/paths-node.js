import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from './constants.js';
export { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT };
export function getCodePulseHome() {
    const override = process.env.CODEPULSE_HOME?.trim();
    if (override) {
        return path.resolve(override);
    }
    const home = os.homedir();
    if (process.platform === 'win32') {
        return path.join(process.env.USERPROFILE || home, '.codepulse');
    }
    return path.join(home, '.codepulse');
}
export function readDaemonToken(homeDir = getCodePulseHome()) {
    const tokenPath = path.join(homeDir, 'token');
    try {
        const token = fs.readFileSync(tokenPath, 'utf8').trim();
        return token || undefined;
    }
    catch {
        return undefined;
    }
}
export function readDaemonPort(homeDir = getCodePulseHome()) {
    const envPort = process.env.CODEPULSE_DAEMON_PORT?.trim();
    if (envPort) {
        const parsed = Number.parseInt(envPort, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
            return parsed;
        }
    }
    const portPath = path.join(homeDir, 'port');
    try {
        const filePort = fs.readFileSync(portPath, 'utf8').trim();
        const parsed = Number.parseInt(filePort, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
            return parsed;
        }
    }
    catch {
        // fall through to default
    }
    return DEFAULT_DAEMON_PORT;
}
export function readDaemonHost() {
    return process.env.CODEPULSE_DAEMON_HOST?.trim() || DEFAULT_DAEMON_HOST;
}
//# sourceMappingURL=paths-node.js.map