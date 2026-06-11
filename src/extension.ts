import * as vscode from 'vscode';
import * as path from 'path';
import { TimeTracker } from './tracker/TimeTracker';
import { StatusBarManager } from './ui/StatusBarManager';
import { WebviewProvider } from './ui/WebviewProvider';
import { DatabaseManager } from './storage/DatabaseManager';
import { ConfigManager } from './utils/ConfigManager';
import { Logger } from './utils/Logger';
import { ApiServer, resolveApiToken } from './api/ApiServer';
import { DaemonClient } from './client/DaemonClient';
import { SyncManager } from './storage/sync/SyncManager';
import { TerminalAiDetector } from './detectors/TerminalAiDetector';
import { AiExtensionDetector } from './detectors/AiExtensionDetector';

let timeTracker: TimeTracker;
let statusBarManager: StatusBarManager;
let webviewProvider: WebviewProvider;
let databaseManager: DatabaseManager;
let configManager: ConfigManager;
let logger: Logger;
let apiServer: ApiServer | undefined;
let daemonClient: DaemonClient | undefined;
let terminalAiDetector: TerminalAiDetector | undefined;
let aiExtensionDetector: AiExtensionDetector | undefined;
let syncManager: SyncManager;
let apiTokenStoragePath: string;

function formatDurationMs(durationMs: number): string {
    const totalMinutes = Math.max(0, Math.round(durationMs / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    return `${minutes}m`;
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('CodePulse extension is now activating...');

    try {
        // Initialize core components
        const databaseStoragePath =
            context.globalStorageUri?.fsPath || context.globalStoragePath || context.extensionPath;
        apiTokenStoragePath = databaseStoragePath;
        const logStoragePath = context.logUri?.fsPath || context.logPath || path.join(databaseStoragePath, 'logs');

        logger = new Logger(logStoragePath);
        logger.info('Initializing CodePulse extension...');

        configManager = new ConfigManager();
        databaseManager = new DatabaseManager(databaseStoragePath);
        await databaseManager.initialize();

        timeTracker = new TimeTracker(context, databaseManager, configManager, logger);
        statusBarManager = new StatusBarManager(timeTracker, configManager);
        webviewProvider = new WebviewProvider(context, timeTracker, databaseManager, configManager);
        syncManager = new SyncManager(context, databaseManager, configManager, logger);
        await syncManager.initialize();

        // Register commands
        const commands = [
            vscode.commands.registerCommand('codepulse.showDashboard', async () => {
                await webviewProvider.showDashboard();
            }),

            vscode.commands.registerCommand('codepulse.toggleTracking', async () => {
                await timeTracker.toggleTracking();
                await webviewProvider.refresh();
                statusBarManager.updateStatusBar();
            }),

            vscode.commands.registerCommand('codepulse.showStats', async () => {
                await timeTracker.showTodaysStats();
            }),

            vscode.commands.registerCommand('codepulse.toggleFocusSession', async () => {
                try {
                    const report = await timeTracker.toggleFocusSession();
                    await webviewProvider.refresh();
                    statusBarManager.updateStatusBar();

                    if (!configManager.shouldShowNotifications()) {
                        return;
                    }

                    if (report) {
                        const summary =
                            `Focus session completed: ${formatDurationMs(report.focusActiveMs)} focused, ` +
                            `${report.distractionCount} distractions.`;
                        void vscode.window.showInformationMessage(summary);
                    } else {
                        void vscode.window.showInformationMessage('Focus session started.');
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`Code Pulse: ${message}`);
                }
            }),

            vscode.commands.registerCommand('codepulse.exportData', async () => {
                await timeTracker.exportData();
            }),

            vscode.commands.registerCommand('codepulse.syncNow', async () => {
                try {
                    await syncManager.syncNow();
                    await webviewProvider.refresh();
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Code Pulse: Sync failed — ${msg}`);
                }
            }),

            vscode.commands.registerCommand('codepulse.testSync', async () => {
                await syncManager.testConnection();
            }),

            vscode.commands.registerCommand('codepulse.resetData', async () => {
                const result = await vscode.window.showWarningMessage(
                    'Are you sure you want to reset all CodePulse data? This action cannot be undone.',
                    { modal: true },
                    'Reset All Data'
                );

                if (result === 'Reset All Data') {
                    await databaseManager.resetAllData();
                    vscode.window.showInformationMessage('All CodePulse data has been reset.');
                }
            }),

            vscode.commands.registerCommand('codepulse.copyApiToken', async () => {
                try {
                    const token = resolveApiToken(configManager, databaseStoragePath);
                    await vscode.env.clipboard.writeText(token);
                    vscode.window.showInformationMessage('Code Pulse API token copied to clipboard.');
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Code Pulse: Failed to copy API token — ${message}`);
                }
            })
        ];

        // Register all commands with context
        commands.forEach(command => context.subscriptions.push(command));

        // Register webview provider
        context.subscriptions.push(vscode.window.registerWebviewViewProvider('codepulse.stats', webviewProvider));

        context.subscriptions.push({
            dispose: () => logger?.dispose()
        });

        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(async event => {
                if (event.affectsConfiguration('codepulse')) {
                    await synchronizeRuntimeConfiguration();
                }
            })
        );

        await synchronizeRuntimeConfiguration();

        // Prune old data based on retention policy
        const retentionDays = configManager.get<number>('dataRetentionDays', 90);
        databaseManager
            .pruneOldData(retentionDays)
            .then(pruned => {
                if (pruned > 0) {
                    logger.info(`Pruned ${pruned} records older than ${retentionDays} days`);
                }
            })
            .catch(err => {
                logger.warn('Failed to prune old data', err instanceof Error ? err : new Error(String(err)));
            });

        logger.info('CodePulse extension activated successfully');

        // Show welcome message on first activation
        const isFirstActivation = context.globalState.get('codepulse.firstActivation', true);
        if (isFirstActivation && configManager.shouldShowWelcomeMessage() && configManager.shouldShowNotifications()) {
            await context.globalState.update('codepulse.firstActivation', false);
            vscode.window
                .showInformationMessage(
                    'Welcome to Code Pulse! Time tracking is now active. Click the status bar item to view your dashboard.',
                    'Show Dashboard'
                )
                .then(selection => {
                    if (selection === 'Show Dashboard') {
                        vscode.commands.executeCommand('codepulse.showDashboard');
                    }
                });
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const logError = error instanceof Error ? error : new Error(String(error));
        logger?.error('Failed to activate CodePulse extension', logError);
        vscode.window.showErrorMessage(`Failed to activate CodePulse: ${errorMessage}`);
    }

    async function synchronizeRuntimeConfiguration(): Promise<void> {
        await vscode.commands.executeCommand('setContext', 'codepulse.enabled', configManager.isEnabled());

        try {
            await synchronizeDaemonClient();
        } catch (error) {
            // Daemon connectivity must never block applying the remaining configuration.
            const logError = error instanceof Error ? error : new Error(String(error));
            logger.warn('Failed to synchronize daemon client, continuing configuration update', logError);
        }

        await timeTracker.refreshConfiguration();
        statusBarManager.refreshConfiguration();

        if (configManager.isLocalServerEnabled()) {
            if (!apiServer) {
                apiServer = new ApiServer(timeTracker, databaseManager, configManager, apiTokenStoragePath);
            }
            if (apiServer.isServerRunning()) {
                apiServer.updateConfiguration();
            } else {
                await apiServer.start();
            }
        } else if (apiServer) {
            await apiServer.stop();
            apiServer = undefined;
        }

        // Re-initialize sync if its config changed
        if (syncManager) {
            await syncManager.reconfigure();
        }

        await webviewProvider.refresh();
        statusBarManager.updateStatusBar();
    }

    async function synchronizeDaemonClient(): Promise<void> {
        if (!configManager.isDaemonEnabled()) {
            disposeAiDetectors();
            webviewProvider.setAiSources(undefined);

            if (daemonClient) {
                timeTracker.setSessionEndedHandler(undefined);
                await daemonClient.disconnect();
                daemonClient = undefined;
            }

            await vscode.commands.executeCommand('setContext', 'codepulse.daemon.connected', false);
            return;
        }

        if (!daemonClient) {
            daemonClient = new DaemonClient(configManager, logger);
            // When the reconnect probe finds the daemon again, re-run the full wiring so
            // event forwarding and the codepulse.daemon.connected context resume.
            daemonClient.setReconnectedHandler(() => synchronizeDaemonClient());
            context.subscriptions.push({
                dispose: () => {
                    void daemonClient?.disconnect();
                }
            });
        }

        await daemonClient.refreshConnection();
        await vscode.commands.executeCommand(
            'setContext',
            'codepulse.daemon.connected',
            daemonClient.isDaemonMode()
        );

        if (daemonClient.isDaemonMode()) {
            daemonClient.startForwarding(() => timeTracker.getCurrentSession());
            timeTracker.setSessionEndedHandler(session => daemonClient?.notifySessionEnded(session));
        } else {
            daemonClient.stopForwarding();
            timeTracker.setSessionEndedHandler(undefined);
        }

        // AI detectors run whenever daemon integration is enabled — their local
        // state keeps the dashboard's AI Tools card alive even while the daemon
        // is unreachable (forwarding self-gates on daemon mode per detection).
        if (!terminalAiDetector) {
            terminalAiDetector = new TerminalAiDetector(daemonClient, logger);
            terminalAiDetector.start();
        }

        if (!aiExtensionDetector) {
            aiExtensionDetector = new AiExtensionDetector(daemonClient, logger);
            aiExtensionDetector.start();
        }

        webviewProvider.setAiSources({
            daemonClient,
            terminalDetector: terminalAiDetector,
            extensionDetector: aiExtensionDetector
        });
    }
}

function disposeAiDetectors(): void {
    if (terminalAiDetector) {
        terminalAiDetector.dispose();
        terminalAiDetector = undefined;
    }

    if (aiExtensionDetector) {
        aiExtensionDetector.dispose();
        aiExtensionDetector = undefined;
    }
}

export async function deactivate() {
    console.log('CodePulse extension is deactivating...');

    try {
        // Stop time tracking
        if (timeTracker) {
            await timeTracker.stop();
        }

        // Stop sync manager and push final snapshot
        if (syncManager) {
            try {
                await syncManager.pushSnapshot();
            } catch {
                /* best-effort */
            }
            syncManager.stop();
        }

        // Stop API server
        if (apiServer) {
            await apiServer.stop();
        }

        disposeAiDetectors();

        if (daemonClient) {
            await daemonClient.disconnect();
        }

        // Clean up status bar
        if (statusBarManager) {
            statusBarManager.dispose();
        }

        // Close database connection
        if (databaseManager) {
            await databaseManager.close();
        }

        logger?.info('CodePulse extension deactivated successfully');
    } catch (error) {
        const logError = error instanceof Error ? error : new Error(String(error));
        logger?.error('Error during deactivation', logError);
        console.error('Error during CodePulse deactivation:', error);
    }
}
