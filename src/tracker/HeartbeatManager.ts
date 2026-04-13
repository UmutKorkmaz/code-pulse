import { ConfigManager } from '../utils/ConfigManager';
import { Logger } from '../utils/Logger';

export class HeartbeatManager {
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private intervalMs: number;
    private isRunning = false;
    private heartbeatCallback: (() => Promise<void>) | null = null;

    constructor(
        private configManager: ConfigManager,
        private logger: Logger
    ) {
        this.intervalMs = this.configManager.get('heartbeatInterval', 120) * 1000; // Convert to milliseconds
    }

    public start(callback: () => Promise<void>): void {
        if (this.isRunning) {
            this.logger.warn('HeartbeatManager is already running');
            return;
        }

        this.heartbeatCallback = callback;
        this.isRunning = true;

        this.logger.info(`Starting heartbeat manager with interval: ${this.intervalMs}ms`);

        // Send initial heartbeat
        this.sendHeartbeat();

        // Start periodic heartbeats
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, this.intervalMs);
    }

    public stop(): void {
        if (!this.isRunning) {
            return;
        }

        this.logger.info('Stopping heartbeat manager');

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        this.isRunning = false;
        this.heartbeatCallback = null;
    }

    public updateConfiguration(): void {
        const newIntervalMs = this.configManager.get('heartbeatInterval', 120) * 1000;

        if (newIntervalMs !== this.intervalMs) {
            this.logger.info(`Updating heartbeat interval from ${this.intervalMs}ms to ${newIntervalMs}ms`);
            this.intervalMs = newIntervalMs;

            // Restart with new interval if currently running
            if (this.isRunning && this.heartbeatCallback) {
                const callback = this.heartbeatCallback;
                this.stop();
                this.start(callback);
            }
        }
    }

    public forceHeartbeat(): void {
        if (this.isRunning) {
            this.sendHeartbeat();
        }
    }

    public isActive(): boolean {
        return this.isRunning;
    }

    public getIntervalMs(): number {
        return this.intervalMs;
    }

    private async sendHeartbeat(): Promise<void> {
        if (!this.heartbeatCallback) {
            return;
        }

        try {
            await this.heartbeatCallback();
            this.logger.debug('Heartbeat sent successfully');
        } catch (error) {
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to send heartbeat', logError);
        }
    }
}