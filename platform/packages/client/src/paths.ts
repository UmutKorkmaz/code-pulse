/**
 * @deprecated Browser bundles must import from `@codepulse/client/browser`.
 * Node-only path helpers live in `paths-node.ts`.
 */
export {
    DEFAULT_DAEMON_HOST,
    DEFAULT_DAEMON_PORT,
    getCodePulseHome,
    readDaemonHost,
    readDaemonPort,
    readDaemonToken
} from './paths-node.js';