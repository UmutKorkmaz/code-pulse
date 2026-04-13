import axios, { AxiosInstance } from 'axios';
import { ConfigManager } from '../utils/ConfigManager';
import { Logger } from '../utils/Logger';
import { CodingSession } from '../tracker/TimeTracker';
import { ActivityEvent } from '../tracker/ActivityDetector';

export interface SyncStatus {
    enabled: boolean;
    lastSyncTime?: Date;
    pendingSessions: number;
    pendingActivities: number;
    connectionStatus: 'connected' | 'disconnected' | 'error';
    errorMessage?: string;
}

export interface CloudSyncConfig {
    apiUrl: string;
    apiKey: string;
    syncInterval: number;
    retryAttempts: number;
    timeout: number;
}

export class CloudSync {
    private client: AxiosInstance;
    private syncTimer: NodeJS.Timeout | null = null;
    private pendingSessions: CodingSession[] = [];
    private pendingActivities: ActivityEvent[] = [];
    private isEnabled = false;
    private connectionStatus: 'connected' | 'disconnected' | 'error' = 'disconnected';
    private lastSyncTime: Date | null = null;
    private config: CloudSyncConfig;

    constructor(
        private configManager: ConfigManager,
        private logger: Logger
    ) {
        this.config = this.loadConfig();
        this.isEnabled = this.configManager.get('cloudSync.enabled', false);

        this.client = axios.create({
            baseURL: this.config.apiUrl,
            timeout: this.config.timeout,
            headers: {
                'Authorization': `Bearer ${this.config.apiKey}`,
                'Content-Type': 'application/json',
                'User-Agent': 'CodePulse/1.0.0'
            }
        });

        if (this.isEnabled && this.config.apiUrl && this.config.apiKey) {
            void this.initialize().catch((error) => {
                const logError = error instanceof Error ? error : new Error(String(error));
                this.logger.error('Initial cloud sync bootstrap failed', logError);
            });
        }
    }

    public async initialize(): Promise<void> {
        if (!this.isEnabled) {
            return;
        }

        try {
            this.logger.info('Initializing cloud sync...');

            // Test connection
            await this.testConnection();
            this.connectionStatus = 'connected';

            // Start periodic sync
            this.startPeriodicSync();

            this.logger.info('Cloud sync initialized successfully');

        } catch (error) {
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to initialize cloud sync', logError);
            this.connectionStatus = 'error';
            throw error;
        }
    }

    public async syncSession(session: CodingSession): Promise<void> {
        if (!this.isEnabled || this.connectionStatus !== 'connected') {
            this.pendingSessions.push(session);
            return;
        }

        try {
            await this.uploadSession(session);
            this.logger.debug(`Session synced: ${session.id}`);

        } catch (error) {
            this.logger.warn(`Failed to sync session, adding to pending: ${error}`);
            this.pendingSessions.push(session);
        }
    }

    public async syncActivity(activity: ActivityEvent): Promise<void> {
        if (!this.isEnabled || this.connectionStatus !== 'connected') {
            this.pendingActivities.push(activity);
            return;
        }

        try {
            await this.uploadActivity(activity);
            this.logger.debug(`Activity synced: ${activity.type}`);

        } catch (error) {
            this.logger.warn(`Failed to sync activity, adding to pending: ${error}`);
            this.pendingActivities.push(activity);
        }
    }

    public async syncPendingData(): Promise<void> {
        if (!this.isEnabled || this.connectionStatus !== 'connected') {
            return;
        }

        try {
            const failedSessions: CodingSession[] = [];
            for (const session of this.pendingSessions) {
                try {
                    await this.uploadSession(session);
                } catch (error) {
                    this.logger.warn(`Failed to sync pending session ${session.id}: ${error}`);
                    failedSessions.push(session);
                }
            }

            const failedActivities: ActivityEvent[] = [];
            for (const activity of this.pendingActivities) {
                try {
                    await this.uploadActivity(activity);
                } catch (error) {
                    this.logger.warn(`Failed to sync pending activity: ${error}`);
                    failedActivities.push(activity);
                }
            }

            this.pendingSessions = failedSessions;
            this.pendingActivities = failedActivities;
            this.lastSyncTime = new Date();

            this.logger.info('Pending data sync completed');

        } catch (error) {
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to sync pending data', logError);
        }
    }

    public async exportToCloud(sessions: CodingSession[], activities: ActivityEvent[]): Promise<void> {
        if (!this.isEnabled || this.connectionStatus !== 'connected') {
            throw new Error('Cloud sync not available');
        }

        try {
            const exportData = {
                timestamp: new Date().toISOString(),
                sessions,
                activities,
                metadata: {
                    version: '1.0.0',
                    source: 'codepulse-vscode'
                }
            };

            await this.client.post('/export', exportData);
            this.logger.info('Data exported to cloud successfully');

        } catch (error) {
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to export data to cloud', logError);
            throw error;
        }
    }

    public async importFromCloud(startDate: Date, endDate: Date): Promise<{
        sessions: CodingSession[];
        activities: ActivityEvent[];
    }> {
        if (!this.isEnabled || this.connectionStatus !== 'connected') {
            throw new Error('Cloud sync not available');
        }

        try {
            const response = await this.client.get('/import', {
                params: {
                    start_date: startDate.toISOString(),
                    end_date: endDate.toISOString()
                }
            });

            this.logger.info('Data imported from cloud successfully');
            return response.data;

        } catch (error) {
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to import data from cloud', logError);
            throw error;
        }
    }

    public getSyncStatus(): SyncStatus {
        return {
            enabled: this.isEnabled,
            lastSyncTime: this.lastSyncTime || undefined,
            pendingSessions: this.pendingSessions.length,
            pendingActivities: this.pendingActivities.length,
            connectionStatus: this.connectionStatus,
            errorMessage: this.connectionStatus === 'error' ? 'Failed to connect to sync server' : undefined
        };
    }

    public async testConnection(): Promise<boolean> {
        try {
            const response = await this.client.get('/health');
            return response.status === 200;

        } catch (error) {
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Cloud sync connection test failed', logError);
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Connection test failed: ${errorMessage}`);
        }
    }

    public updateConfiguration(): void {
        const newConfig = this.loadConfig();
        const newEnabled = this.configManager.get('cloudSync.enabled', false);

        // Check if configuration changed
        if (JSON.stringify(newConfig) !== JSON.stringify(this.config) || newEnabled !== this.isEnabled) {
            this.config = newConfig;
            this.isEnabled = newEnabled;

            // Recreate client with new config
            this.client = axios.create({
                baseURL: this.config.apiUrl,
                timeout: this.config.timeout,
                headers: {
                    'Authorization': `Bearer ${this.config.apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'CodePulse/1.0.0'
                }
            });

            // Restart sync if enabled
            if (this.isEnabled) {
                this.initialize().catch(err => {
                    this.logger.error('Failed to reinitialize cloud sync after config change', err);
                });
            } else {
                this.stop();
            }
        }
    }

    public stop(): void {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }

        this.connectionStatus = 'disconnected';
        this.logger.info('Cloud sync stopped');
    }

    private loadConfig(): CloudSyncConfig {
        return {
            apiUrl: this.configManager.get('cloudSync.apiUrl', ''),
            apiKey: this.configManager.get('cloudSync.apiKey', ''),
            syncInterval: this.configManager.get('cloudSync.syncInterval', 300000), // 5 minutes
            retryAttempts: this.configManager.get('cloudSync.retryAttempts', 3),
            timeout: this.configManager.get('cloudSync.timeout', 30000) // 30 seconds
        };
    }

    private startPeriodicSync(): void {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
        }

        this.syncTimer = setInterval(() => {
            this.syncPendingData().catch(err => {
                this.logger.error('Periodic sync failed', err);
            });
        }, this.config.syncInterval);

        this.logger.info(`Periodic sync started with interval: ${this.config.syncInterval}ms`);
    }

    private async uploadSession(session: CodingSession): Promise<void> {
        const sessionData = {
            id: session.id,
            start_time: session.startTime.toISOString(),
            end_time: session.endTime?.toISOString(),
            duration: session.duration,
            idle_duration: session.idleDuration,
            project: session.project,
            language: session.language,
            file: this.configManager.shouldIncludeFilenamesInCloudSync() ? session.file : undefined,
            branch: session.branch,
            is_active: session.isActive,
            heartbeats: session.heartbeats,
            keystrokes: session.keystrokes,
            lines_added: session.linesAdded,
            lines_removed: session.linesRemoved,
            productivity_score: session.productivityScore
        };

        await this.client.post('/sessions', sessionData);
    }

    private async uploadActivity(activity: ActivityEvent): Promise<void> {
        const activityData = {
            type: activity.type,
            timestamp: activity.timestamp.toISOString(),
            session_id: activity.sessionId,
            is_idle: activity.isIdle,
            file: this.configManager.shouldIncludeFilenamesInCloudSync() ? activity.file : undefined,
            language: activity.language,
            project: activity.project,
            metadata: activity.metadata
        };

        await this.client.post('/activities', activityData);
    }
}
