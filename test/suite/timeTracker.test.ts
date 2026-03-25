import * as assert from 'assert';
import * as vscode from 'vscode';
import { TimeTracker } from '../../src/tracker/TimeTracker';
import { DatabaseManager } from '../../src/storage/DatabaseManager';
import { ConfigManager } from '../../src/utils/ConfigManager';
import { Logger } from '../../src/utils/Logger';

suite('TimeTracker Test Suite', () => {
    let timeTracker: TimeTracker;
    let databaseManager: DatabaseManager;
    let configManager: ConfigManager;
    let logger: Logger;
    let mockContext: vscode.ExtensionContext;

    suiteSetup(async () => {
        // Create mock context
        mockContext = {
            subscriptions: [],
            workspaceState: {
                get: () => undefined,
                update: async () => {},
                keys: () => []
            },
            globalState: {
                get: () => undefined,
                update: async () => {},
                keys: () => [],
                setKeysForSync: () => {}
            },
            extensionPath: __dirname,
            extensionUri: vscode.Uri.file(__dirname),
            environmentVariableCollection: {} as any,
            extensionMode: vscode.ExtensionMode.Test,
            storageUri: vscode.Uri.file(__dirname),
            globalStorageUri: vscode.Uri.file(__dirname),
            logUri: vscode.Uri.file(__dirname),
            storagePath: __dirname,
            globalStoragePath: __dirname,
            logPath: __dirname,
            asAbsolutePath: (path: string) => path,
            languageModelAccessInformation: {} as any,
            secrets: {} as any,
            extension: {} as any
        } as unknown as vscode.ExtensionContext;

        // Initialize components
        logger = new Logger(__dirname, 'debug');
        configManager = new ConfigManager();
        databaseManager = new DatabaseManager(__dirname);
        await databaseManager.initialize();
        
        timeTracker = new TimeTracker(mockContext, databaseManager, configManager, logger);
    });

    suiteTeardown(async () => {
        if (timeTracker) {
            await timeTracker.stop();
        }
        if (databaseManager) {
            await databaseManager.close();
        }
        if (logger) {
            logger.dispose();
        }
    });

    test('TimeTracker should initialize', () => {
        assert.ok(timeTracker);
        assert.strictEqual(timeTracker.getCurrentSession(), null);
    });

    test('TimeTracker should start tracking', async () => {
        await timeTracker.start();
        
        // Wait a bit for session to be created
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const session = timeTracker.getCurrentSession();
        assert.ok(session);
        assert.strictEqual(session.isActive, true);
        assert.ok(session.startTime);
        assert.strictEqual(typeof session.id, 'string');
    });

    test('TimeTracker should stop tracking', async () => {
        await timeTracker.start();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const sessionBefore = timeTracker.getCurrentSession();
        assert.ok(sessionBefore);
        assert.strictEqual(sessionBefore.isActive, true);
        
        await timeTracker.stop();
        
        const sessionAfter = timeTracker.getCurrentSession();
        assert.strictEqual(sessionAfter, null);
    });

    test('TimeTracker should toggle tracking', async () => {
        // Initially not tracking
        assert.strictEqual(timeTracker.getCurrentSession(), null);
        
        // Start tracking
        timeTracker.toggleTracking();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const session1 = timeTracker.getCurrentSession();
        assert.ok(session1);
        assert.strictEqual(session1.isActive, true);
        
        // Stop tracking
        timeTracker.toggleTracking();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const session2 = timeTracker.getCurrentSession();
        assert.strictEqual(session2, null);
    });

    test('TimeTracker should get today stats', async () => {
        const stats = await timeTracker.getTodaysStats();
        
        assert.ok(stats);
        assert.ok(typeof stats.date === 'string');
        assert.ok(typeof stats.totalTime === 'number');
        assert.ok(typeof stats.activeTime === 'number');
        assert.ok(typeof stats.projects === 'object');
        assert.ok(typeof stats.languages === 'object');
        assert.ok(typeof stats.files === 'object');
        assert.ok(typeof stats.productivity === 'object');
    });

    test('TimeTracker should get weekly stats', async () => {
        const stats = await timeTracker.getWeeklyStats();
        
        assert.ok(Array.isArray(stats));
        assert.strictEqual(stats.length, 7);
        
        stats.forEach(dayStat => {
            assert.ok(typeof dayStat.date === 'string');
            assert.ok(typeof dayStat.totalTime === 'number');
            assert.ok(typeof dayStat.activeTime === 'number');
            assert.ok(typeof dayStat.projects === 'object');
            assert.ok(typeof dayStat.languages === 'object');
            assert.ok(typeof dayStat.files === 'object');
            assert.ok(typeof dayStat.productivity === 'object');
        });
    });

    test('Session should track duration', async function() {
        this.timeout(5000);
        
        await timeTracker.start();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const session1 = timeTracker.getCurrentSession();
        assert.ok(session1);
        
        const initialDuration = session1.duration;
        
        // Wait a bit more
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const session2 = timeTracker.getCurrentSession();
        assert.ok(session2);
        
        // Duration should have increased
        assert.ok(session2.duration > initialDuration);
        
        await timeTracker.stop();
    });

    test('Should handle export data', async () => {
        // Mock vscode.window.showSaveDialog
        const originalShowSaveDialog = vscode.window.showSaveDialog;
        let saveDialogCalled = false;
        
        (vscode.window.showSaveDialog as any) = async () => {
            saveDialogCalled = true;
            return undefined; // User cancelled
        };
        
        try {
            await timeTracker.exportData();
            assert.ok(saveDialogCalled, 'Save dialog should have been called');
        } finally {
            // Restore original method
            vscode.window.showSaveDialog = originalShowSaveDialog;
        }
    });
});
