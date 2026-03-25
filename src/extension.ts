import * as vscode from 'vscode';
import * as path from 'path';
import { TimeTracker } from './tracker/TimeTracker';
import { StatusBarManager } from './ui/StatusBarManager';
import { WebviewProvider } from './ui/WebviewProvider';
import { DatabaseManager } from './storage/DatabaseManager';
import { ConfigManager } from './utils/ConfigManager';
import { Logger } from './utils/Logger';
import { ApiServer } from './api/ApiServer';

let timeTracker: TimeTracker;
let statusBarManager: StatusBarManager;
let webviewProvider: WebviewProvider;
let databaseManager: DatabaseManager;
let configManager: ConfigManager;
let logger: Logger;
let apiServer: ApiServer | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log('CodePulse extension is now activating...');
    
    try {
        // Initialize core components
        const databaseStoragePath = context.globalStorageUri?.fsPath || context.globalStoragePath || context.extensionPath;
        const logStoragePath = context.logUri?.fsPath || context.logPath || path.join(databaseStoragePath, 'logs');

        logger = new Logger(logStoragePath);
        logger.info('Initializing CodePulse extension...');
        
        configManager = new ConfigManager();
        databaseManager = new DatabaseManager(databaseStoragePath);
        await databaseManager.initialize();
        
        timeTracker = new TimeTracker(context, databaseManager, configManager, logger);
        statusBarManager = new StatusBarManager(timeTracker, configManager);
        webviewProvider = new WebviewProvider(context, timeTracker, databaseManager, configManager);
        
        // Register commands
        const commands = [
            vscode.commands.registerCommand('codepulse.showDashboard', () => {
                webviewProvider.showDashboard();
            }),
            
            vscode.commands.registerCommand('codepulse.toggleTracking', () => {
                timeTracker.toggleTracking();
            }),
            
            vscode.commands.registerCommand('codepulse.showStats', () => {
                timeTracker.showTodaysStats();
            }),
            
            vscode.commands.registerCommand('codepulse.exportData', async () => {
                await timeTracker.exportData();
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
            })
        ];
        
        // Register all commands with context
        commands.forEach(command => context.subscriptions.push(command));
        
        // Register webview provider
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('codepulse.stats', webviewProvider)
        );

        context.subscriptions.push({
            dispose: () => logger?.dispose()
        });

        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(async (event) => {
                if (event.affectsConfiguration('codepulse')) {
                    await synchronizeRuntimeConfiguration();
                }
            })
        );

        await synchronizeRuntimeConfiguration();
        
        logger.info('CodePulse extension activated successfully');
        
        // Show welcome message on first activation
        const isFirstActivation = context.globalState.get('codepulse.firstActivation', true);
        if (isFirstActivation && configManager.shouldShowWelcomeMessage() && configManager.shouldShowNotifications()) {
            await context.globalState.update('codepulse.firstActivation', false);
            vscode.window.showInformationMessage(
                'Welcome to CodePulse! Time tracking is now active. Click the status bar item to view your dashboard.',
                'Show Dashboard'
            ).then(selection => {
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

        await timeTracker.refreshConfiguration();
        statusBarManager.refreshConfiguration();

        if (configManager.isLocalServerEnabled()) {
            if (!apiServer) {
                apiServer = new ApiServer(timeTracker, databaseManager, configManager);
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

        await webviewProvider.refresh();
        statusBarManager.updateStatusBar();
    }
}

export async function deactivate() {
    console.log('CodePulse extension is deactivating...');
    
    try {
        // Stop time tracking
        if (timeTracker) {
            await timeTracker.stop();
        }
        
        // Stop API server
        if (apiServer) {
            await apiServer.stop();
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
