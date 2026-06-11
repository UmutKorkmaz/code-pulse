import { createDaemonClient } from '@codepulse/client';
import { printJson, printTable } from '../format.js';
export async function runRegistryList(json) {
    const client = createDaemonClient();
    try {
        const registry = await client.getRegistry();
        const scanners = registry.scanners ?? [];
        if (json) {
            printJson({
                daemonUrl: client.getBaseUrl(),
                updatedAt: registry.updatedAt,
                scanners
            });
        }
        else if (scanners.length === 0) {
            console.log('No registry scanners installed.');
        }
        else {
            printTable(['ID', 'NAME', 'VERSION', 'TRUST', 'ENABLED'], scanners.map(scanner => [
                scanner.id,
                scanner.displayName ?? '-',
                scanner.version ?? '-',
                scanner.trust ?? '-',
                scanner.enabled === false ? 'no' : 'yes'
            ]));
        }
        return 0;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (json) {
            printJson({
                ok: false,
                daemonUrl: client.getBaseUrl(),
                error: message
            });
        }
        else {
            console.error(`Failed to list registry scanners: ${message}`);
        }
        return 1;
    }
}
//# sourceMappingURL=registry.js.map