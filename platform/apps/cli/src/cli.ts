import { runDaemonPing } from './commands/daemon.js';
import { runDoctor } from './commands/doctor.js';
import { runRegistryList } from './commands/registry.js';
import { runStatus } from './commands/status.js';

export interface ParsedArgs {
    command?: string;
    subcommand?: string;
    json: boolean;
    help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
    const args = [...argv];
    const json = args.includes('--json');
    const help = args.includes('--help') || args.includes('-h');

    const positional = args.filter(arg => !arg.startsWith('-'));

    return {
        command: positional[0],
        subcommand: positional[1],
        json,
        help
    };
}

export function printHelp(): void {
    console.log(`codepulse - Code Pulse CLI

Usage:
  codepulse doctor
  codepulse status [--json]
  codepulse registry list [--json]
  codepulse daemon ping [--json]

Options:
  --json    Output machine-readable JSON
  --help    Show this help message

Environment:
  CODEPULSE_HOME          Override ~/.codepulse data directory
  CODEPULSE_DAEMON_HOST   Daemon host (default: 127.0.0.1)
  CODEPULSE_DAEMON_PORT   Daemon port (default: 7842)
`);
}

export async function runCli(argv: string[]): Promise<number> {
    const parsed = parseArgs(argv);

    if (parsed.help || !parsed.command) {
        printHelp();
        return parsed.help ? 0 : 1;
    }

    switch (parsed.command) {
        case 'doctor':
            return runDoctor(parsed.json);

        case 'status':
            return runStatus(parsed.json);

        case 'registry':
            if (parsed.subcommand === 'list') {
                return runRegistryList(parsed.json);
            }
            console.error('Unknown registry command. Try: codepulse registry list');
            return 1;

        case 'daemon':
            if (parsed.subcommand === 'ping') {
                return runDaemonPing(parsed.json);
            }
            console.error('Unknown daemon command. Try: codepulse daemon ping');
            return 1;

        default:
            console.error(`Unknown command: ${parsed.command}`);
            printHelp();
            return 1;
    }
}