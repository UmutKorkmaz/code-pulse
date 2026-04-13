import * as vscode from 'vscode';

export interface CodePulseConfig {
    enabled: boolean;
    heartbeatInterval: number;
    idleThreshold: number;
    trackFileChanges: boolean;
    trackProjectSwitching: boolean;
    showStatusBar: boolean;
    cloudSync: {
        enabled: boolean;
        apiUrl: string;
        apiKey: string;
        includeFilenames: boolean;
        syncInterval: number;
        retryAttempts: number;
        timeout: number;
    };
    analytics: {
        enableProductivityScore: boolean;
        enableLanguageStats: boolean;
        enableProjectStats: boolean;
        enableActivityTracking: boolean;
    };
    localServer: {
        enabled: boolean;
        port: number;
        allowExternalConnections: boolean;
    };
    privacy: {
        trackFilenames: boolean;
        trackFileContent: boolean;
        anonymizeData: boolean;
    };
    ui: {
        theme: 'auto' | 'light' | 'dark';
        compactMode: boolean;
        showNotifications: boolean;
        showWelcomeMessage: boolean;
    };
}

export class ConfigManager {
    private static readonly CONFIG_SECTION = 'codepulse';
    private config: vscode.WorkspaceConfiguration;
    private listeners: Array<(config: CodePulseConfig) => void> = [];

    constructor() {
        this.config = vscode.workspace.getConfiguration(ConfigManager.CONFIG_SECTION);

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(ConfigManager.CONFIG_SECTION)) {
                this.reloadConfiguration();
                this.notifyListeners();
            }
        });
    }

    public get<T>(key: string, defaultValue?: T): T {
        return this.config.get<T>(key, defaultValue as T);
    }

    public async set<T>(key: string, value: T, target?: vscode.ConfigurationTarget): Promise<void> {
        await this.config.update(key, value, target || vscode.ConfigurationTarget.Workspace);
    }

    public getAll(): CodePulseConfig {
        return {
            enabled: this.get('enabled', true),
            heartbeatInterval: this.get('heartbeatInterval', 120),
            idleThreshold: this.get('idleThreshold', 300),
            trackFileChanges: this.get('trackFileChanges', true),
            trackProjectSwitching: this.get('trackProjectSwitching', true),
            showStatusBar: this.get('showStatusBar', true),
            cloudSync: {
                enabled: this.get('cloudSync.enabled', false),
                apiUrl: this.get('cloudSync.apiUrl', ''),
                apiKey: this.get('cloudSync.apiKey', ''),
                includeFilenames: this.get('cloudSync.includeFilenames', false),
                syncInterval: this.get('cloudSync.syncInterval', 300000),
                retryAttempts: this.get('cloudSync.retryAttempts', 3),
                timeout: this.get('cloudSync.timeout', 30000)
            },
            analytics: {
                enableProductivityScore: this.get('analytics.enableProductivityScore', true),
                enableLanguageStats: this.get('analytics.enableLanguageStats', true),
                enableProjectStats: this.get('analytics.enableProjectStats', true),
                enableActivityTracking: this.get('analytics.enableActivityTracking', true)
            },
            localServer: {
                enabled: this.get('localServer.enabled', false),
                port: this.get('localServer.port', 8080),
                allowExternalConnections: this.get('localServer.allowExternalConnections', false)
            },
            privacy: {
                trackFilenames: this.get('privacy.trackFilenames', true),
                trackFileContent: this.get('privacy.trackFileContent', false),
                anonymizeData: this.get('privacy.anonymizeData', false)
            },
            ui: {
                theme: this.get('ui.theme', 'auto'),
                compactMode: this.get('ui.compactMode', false),
                showNotifications: this.get('ui.showNotifications', true),
                showWelcomeMessage: this.get('ui.showWelcomeMessage', true)
            }
        };
    }

    public async updateConfig(updates: Partial<CodePulseConfig>): Promise<void> {
        const currentConfig = this.getAll();
        const mergedConfig = this.mergeConfigs(currentConfig, updates);

        await this.setConfig(mergedConfig);
    }

    public async resetToDefaults(): Promise<void> {
        const defaultConfig: CodePulseConfig = {
            enabled: true,
            heartbeatInterval: 120,
            idleThreshold: 300,
            trackFileChanges: true,
            trackProjectSwitching: true,
            showStatusBar: true,
            cloudSync: {
                enabled: false,
                apiUrl: '',
                apiKey: '',
                includeFilenames: false,
                syncInterval: 300000,
                retryAttempts: 3,
                timeout: 30000
            },
            analytics: {
                enableProductivityScore: true,
                enableLanguageStats: true,
                enableProjectStats: true,
                enableActivityTracking: true
            },
            localServer: {
                enabled: false,
                port: 8080,
                allowExternalConnections: false
            },
            privacy: {
                trackFilenames: true,
                trackFileContent: false,
                anonymizeData: false
            },
            ui: {
                theme: 'auto',
                compactMode: false,
                showNotifications: true,
                showWelcomeMessage: true
            }
        };

        await this.setConfig(defaultConfig);
    }

    public validateConfig(config: Partial<CodePulseConfig>): { valid: boolean; errors: string[] } {
        const errors: string[] = [];

        // Validate heartbeat interval
        if (config.heartbeatInterval !== undefined) {
            if (config.heartbeatInterval < 30 || config.heartbeatInterval > 600) {
                errors.push('Heartbeat interval must be between 30 and 600 seconds');
            }
        }

        // Validate idle threshold
        if (config.idleThreshold !== undefined) {
            if (config.idleThreshold < 60 || config.idleThreshold > 1800) {
                errors.push('Idle threshold must be between 60 and 1800 seconds');
            }
        }

        // Validate cloud sync settings
        if (config.cloudSync?.enabled) {
            if (!config.cloudSync.apiUrl) {
                errors.push('Cloud sync API URL is required when cloud sync is enabled');
            }
            if (!config.cloudSync.apiKey) {
                errors.push('Cloud sync API key is required when cloud sync is enabled');
            }
            if (config.cloudSync.syncInterval && config.cloudSync.syncInterval < 60000) {
                errors.push('Cloud sync interval must be at least 60 seconds');
            }
        }

        // Validate local server settings
        if (config.localServer?.enabled) {
            if (config.localServer.port && (config.localServer.port < 3000 || config.localServer.port > 65535)) {
                errors.push('Local server port must be between 3000 and 65535');
            }
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    public isEnabled(): boolean {
        return this.get('enabled', true);
    }

    public isTrackingEnabled(): boolean {
        return this.isEnabled() && (
            this.get('trackFileChanges', true) ||
            this.get('trackProjectSwitching', true)
        );
    }

    public isCloudSyncEnabled(): boolean {
        return this.get('cloudSync.enabled', false) &&
               !!this.get('cloudSync.apiUrl', '') &&
               !!this.get('cloudSync.apiKey', '');
    }

    public isLocalServerEnabled(): boolean {
        return this.get('localServer.enabled', false);
    }

    public shouldShowNotifications(): boolean {
        return this.get('ui.showNotifications', true);
    }

    public shouldTrackFilenames(): boolean {
        return this.get('privacy.trackFilenames', true);
    }

    public shouldTrackFileContent(): boolean {
        return this.get('privacy.trackFileContent', false);
    }

    public shouldAnonymizeData(): boolean {
        return this.get('privacy.anonymizeData', false);
    }

    public shouldShowWelcomeMessage(): boolean {
        return this.get('ui.showWelcomeMessage', true);
    }

    public shouldIncludeFilenamesInCloudSync(): boolean {
        return this.get('cloudSync.includeFilenames', false) && this.shouldTrackFilenames();
    }

    public getTheme(): 'auto' | 'light' | 'dark' {
        return this.get('ui.theme', 'auto');
    }

    public addChangeListener(listener: (config: CodePulseConfig) => void): void {
        this.listeners.push(listener);
    }

    public removeChangeListener(listener: (config: CodePulseConfig) => void): void {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
            this.listeners.splice(index, 1);
        }
    }

    public reloadConfiguration(): void {
        this.config = vscode.workspace.getConfiguration(ConfigManager.CONFIG_SECTION);
    }

    public async openSettings(): Promise<void> {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:codepulse');
    }

    public getConfigurationErrors(): string[] {
        const config = this.getAll();
        const validation = this.validateConfig(config);
        return validation.errors;
    }

    public async promptForMissingConfig(): Promise<boolean> {
        const errors = this.getConfigurationErrors();

        if (errors.length === 0) {
            return true;
        }

        const message = `CodePulse configuration issues found:\n${errors.join('\n')}`;
        const result = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            'Open Settings',
            'Ignore'
        );

        if (result === 'Open Settings') {
            await this.openSettings();
            return false;
        }

        return result === 'Ignore';
    }

    private async setConfig(config: CodePulseConfig): Promise<void> {
        const promises: Promise<void>[] = [];

        // Set all configuration values
        promises.push(this.set('enabled', config.enabled));
        promises.push(this.set('heartbeatInterval', config.heartbeatInterval));
        promises.push(this.set('idleThreshold', config.idleThreshold));
        promises.push(this.set('trackFileChanges', config.trackFileChanges));
        promises.push(this.set('trackProjectSwitching', config.trackProjectSwitching));
        promises.push(this.set('showStatusBar', config.showStatusBar));

        // Cloud sync
        promises.push(this.set('cloudSync.enabled', config.cloudSync.enabled));
        promises.push(this.set('cloudSync.apiUrl', config.cloudSync.apiUrl));
        promises.push(this.set('cloudSync.apiKey', config.cloudSync.apiKey));
        promises.push(this.set('cloudSync.includeFilenames', config.cloudSync.includeFilenames));
        promises.push(this.set('cloudSync.syncInterval', config.cloudSync.syncInterval));
        promises.push(this.set('cloudSync.retryAttempts', config.cloudSync.retryAttempts));
        promises.push(this.set('cloudSync.timeout', config.cloudSync.timeout));

        // Analytics
        promises.push(this.set('analytics.enableProductivityScore', config.analytics.enableProductivityScore));
        promises.push(this.set('analytics.enableLanguageStats', config.analytics.enableLanguageStats));
        promises.push(this.set('analytics.enableProjectStats', config.analytics.enableProjectStats));
        promises.push(this.set('analytics.enableActivityTracking', config.analytics.enableActivityTracking));

        // Local server
        promises.push(this.set('localServer.enabled', config.localServer.enabled));
        promises.push(this.set('localServer.port', config.localServer.port));
        promises.push(this.set('localServer.allowExternalConnections', config.localServer.allowExternalConnections));

        // Privacy
        promises.push(this.set('privacy.trackFilenames', config.privacy.trackFilenames));
        promises.push(this.set('privacy.trackFileContent', config.privacy.trackFileContent));
        promises.push(this.set('privacy.anonymizeData', config.privacy.anonymizeData));

        // UI
        promises.push(this.set('ui.theme', config.ui.theme));
        promises.push(this.set('ui.compactMode', config.ui.compactMode));
        promises.push(this.set('ui.showNotifications', config.ui.showNotifications));
        promises.push(this.set('ui.showWelcomeMessage', config.ui.showWelcomeMessage));

        await Promise.all(promises);
    }

    private mergeConfigs(current: CodePulseConfig, updates: Partial<CodePulseConfig>): CodePulseConfig {
        return {
            enabled: updates.enabled !== undefined ? updates.enabled : current.enabled,
            heartbeatInterval: updates.heartbeatInterval !== undefined ? updates.heartbeatInterval : current.heartbeatInterval,
            idleThreshold: updates.idleThreshold !== undefined ? updates.idleThreshold : current.idleThreshold,
            trackFileChanges: updates.trackFileChanges !== undefined ? updates.trackFileChanges : current.trackFileChanges,
            trackProjectSwitching: updates.trackProjectSwitching !== undefined ? updates.trackProjectSwitching : current.trackProjectSwitching,
            showStatusBar: updates.showStatusBar !== undefined ? updates.showStatusBar : current.showStatusBar,
            cloudSync: {
                ...current.cloudSync,
                ...(updates.cloudSync || {})
            },
            analytics: {
                ...current.analytics,
                ...(updates.analytics || {})
            },
            localServer: {
                ...current.localServer,
                ...(updates.localServer || {})
            },
            privacy: {
                ...current.privacy,
                ...(updates.privacy || {})
            },
            ui: {
                ...current.ui,
                ...(updates.ui || {})
            }
        };
    }

    private notifyListeners(): void {
        const config = this.getAll();
        this.listeners.forEach(listener => {
            try {
                listener(config);
            } catch (error) {
                console.error('Error in configuration change listener:', error);
            }
        });
    }
}
