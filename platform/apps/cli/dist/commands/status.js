import { createDaemonClient } from '@codepulse/client';
import { printJson } from '../format.js';
export async function runStatus(json) {
    const client = createDaemonClient();
    try {
        const status = await client.getStatus();
        if (json) {
            printJson({
                daemonUrl: client.getBaseUrl(),
                ...status
            });
        }
        else {
            console.log('Code Pulse daemon status\n');
            console.log(`URL:      ${client.getBaseUrl()}`);
            console.log(`Service:  ${status.service ?? 'codepulse-d'}`);
            console.log(`Version:  ${status.version ?? 'unknown'}`);
            console.log(`Status:   ${status.status ?? 'unknown'}`);
            if (typeof status.uptime === 'number') {
                console.log(`Uptime:   ${formatDuration(status.uptime)}`);
            }
            if (typeof status.connectedClients === 'number') {
                console.log(`Clients:  ${status.connectedClients}`);
            }
            if (typeof status.isTracking === 'boolean') {
                console.log(`Tracking: ${status.isTracking ? 'yes' : 'no'}`);
            }
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
            console.error(`Failed to fetch daemon status: ${message}`);
        }
        return 1;
    }
}
function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
}
//# sourceMappingURL=status.js.map