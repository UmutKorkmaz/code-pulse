import { createDaemonClient } from '@codepulse/client';
import { printJson } from '../format.js';

export async function runDaemonPing(json: boolean): Promise<number> {
    const client = createDaemonClient();
    const result = await client.ping();

    if (json) {
        printJson({
            daemonUrl: client.getBaseUrl(),
            ...result
        });
    } else if (result.ok) {
        console.log(`pong ${client.getBaseUrl()} (${result.latencyMs}ms)`);
        if (result.health?.status) {
            console.log(`health: ${result.health.status}`);
        }
    } else {
        console.error(`ping failed: ${result.error}`);
    }

    return result.ok ? 0 : 1;
}