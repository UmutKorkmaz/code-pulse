import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import { DatabaseManager } from '../DatabaseManager';
import { ConfigManager } from '../../utils/ConfigManager';
import { Logger } from '../../utils/Logger';
import { ProviderKind, SyncProvider, SyncSnapshot } from './SyncProvider';
import {
    CustomRestProvider,
    WebDavProvider,
    GitHubGistProvider,
    GoogleDriveProvider,
    OneDriveProvider,
    DropboxProvider
} from './providers';

const DEVICE_ID_KEY = 'codepulse.deviceId';
const GIST_ID_KEY = 'codepulse.sync.gistId';

/**
 * Orchestrates snapshot-based sync across devices.
 * - On activation: pulls remote snapshot, merges into local DB
 * - Periodically and at session end: uploads local snapshot
 */
export class SyncManager {
    private provider?: SyncProvider;
    private deviceId: string;
    private syncTimer?: NodeJS.Timeout;

    constructor(
        private context: vscode.ExtensionContext,
        private databaseManager: DatabaseManager,
        private configManager: ConfigManager,
        private logger: Logger
    ) {
        this.deviceId = this.getOrCreateDeviceId();
    }

    private getOrCreateDeviceId(): string {
        let id = this.context.globalState.get<string>(DEVICE_ID_KEY);
        if (!id) {
            id = `${os.hostname()}-${crypto.randomBytes(4).toString('hex')}`;
            void this.context.globalState.update(DEVICE_ID_KEY, id);
        }
        return id;
    }

    public async initialize(): Promise<void> {
        if (!this.configManager.get<boolean>('sync.enabled', false)) {
            return;
        }
        this.provider = this.buildProvider();
        if (!this.provider) {
            this.logger.warn('Sync enabled but no valid provider configuration found');
            return;
        }

        this.logger.info(`Sync initialized with provider: ${this.provider.name}`);

        // Pull + merge on startup (non-blocking)
        this.pullAndMerge().catch(err => {
            this.logger.warn('Initial sync pull failed', err instanceof Error ? err : new Error(String(err)));
        });

        // Periodic push
        const intervalMs = this.configManager.get<number>('sync.intervalMs', 5 * 60 * 1000);
        this.syncTimer = setInterval(() => {
            this.pushSnapshot().catch(err => {
                this.logger.warn('Periodic sync push failed', err instanceof Error ? err : new Error(String(err)));
            });
        }, Math.max(60000, intervalMs));
    }

    public stop(): void {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = undefined;
        }
        this.provider = undefined;
    }

    public async reconfigure(): Promise<void> {
        this.stop();
        await this.initialize();
    }

    /** User-triggered sync: pull latest, merge, then push */
    public async syncNow(): Promise<void> {
        if (!this.provider) {
            void vscode.window.showWarningMessage('Code Pulse: Sync is not configured. Enable it in settings.');
            return;
        }
        await this.pullAndMerge();
        await this.pushSnapshot();
        void vscode.window.showInformationMessage(`Code Pulse: Synced via ${this.provider.name}`);
    }

    public async pushSnapshot(): Promise<void> {
        if (!this.provider) return;
        const snapshot = await this.buildLocalSnapshot();
        const result = await this.provider.upload(snapshot);
        if (!result.success) {
            throw new Error(result.error || 'Upload failed');
        }
        // Persist Gist ID if newly created
        if (this.provider instanceof GitHubGistProvider) {
            const id = this.provider.getGistId();
            if (id) await this.context.globalState.update(GIST_ID_KEY, id);
        }
        this.logger.debug(`Sync push complete → ${this.provider.name}`);
    }

    public async pullAndMerge(): Promise<void> {
        if (!this.provider) return;
        const result = await this.provider.download();
        if (!result.success) {
            throw new Error(result.error || 'Download failed');
        }
        if (!result.snapshot) {
            this.logger.debug('No remote snapshot to merge');
            return;
        }
        const merged = await this.databaseManager.mergeSnapshot(result.snapshot);
        this.logger.info(`Sync merge complete: ${merged} new records from ${result.snapshot.deviceId}`);
    }

    public async testConnection(): Promise<boolean> {
        const provider = this.buildProvider();
        if (!provider) {
            void vscode.window.showErrorMessage('Code Pulse: Sync provider is not configured.');
            return false;
        }
        const result = await provider.test();
        if (result.success) {
            void vscode.window.showInformationMessage(`Code Pulse: ${provider.name} connection OK`);
            return true;
        }
        void vscode.window.showErrorMessage(`Code Pulse: ${provider.name} test failed — ${result.error}`);
        return false;
    }

    private buildProvider(): SyncProvider | undefined {
        const kind = this.configManager.get<ProviderKind>('sync.provider', 'custom');
        const cfg = <T>(key: string, fallback: T): T => this.configManager.get<T>(`sync.${key}`, fallback);

        switch (kind) {
            case 'custom': {
                const url = cfg<string>('custom.apiUrl', '');
                const key = cfg<string>('custom.apiKey', '');
                if (!url || !key) return undefined;
                return new CustomRestProvider(url, key);
            }
            case 'webdav': {
                const url = cfg<string>('webdav.url', '');
                const user = cfg<string>('webdav.username', '');
                const pass = cfg<string>('webdav.password', '');
                if (!url || !user) return undefined;
                return new WebDavProvider(url, user, pass, cfg<string>('webdav.path', 'codepulse-sync.json'));
            }
            case 'github-gist': {
                const gistId = this.context.globalState.get<string>(GIST_ID_KEY);
                return new GitHubGistProvider(gistId);
            }
            case 'google-drive': {
                const token = cfg<string>('googleDrive.accessToken', '');
                if (!token) return undefined;
                return new GoogleDriveProvider(token, cfg<string>('googleDrive.fileId', '') || undefined);
            }
            case 'onedrive': {
                const token = cfg<string>('oneDrive.accessToken', '');
                if (!token) return undefined;
                return new OneDriveProvider(token, cfg<string>('oneDrive.filePath', '/codepulse-sync.json'));
            }
            case 'dropbox': {
                const token = cfg<string>('dropbox.accessToken', '');
                if (!token) return undefined;
                return new DropboxProvider(token, cfg<string>('dropbox.filePath', '/codepulse-sync.json'));
            }
            default:
                return undefined;
        }
    }

    private async buildLocalSnapshot(): Promise<SyncSnapshot> {
        const data = await this.databaseManager.exportAllData();
        return {
            version: data.version,
            deviceId: this.deviceId,
            updatedAt: new Date().toISOString(),
            sessions: data.sessions,
            activities: data.activities,
            segments: data.segments,
            dailyRollups: data.dailyRollups
        };
    }
}
