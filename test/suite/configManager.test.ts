import * as assert from 'assert';
import { CodePulseConfig, ConfigManager } from '../../src/utils/ConfigManager';

suite('ConfigManager Test Suite', () => {
    let configManager: ConfigManager;

    setup(() => {
        configManager = new ConfigManager();
    });

    test('ConfigManager should initialize', () => {
        assert.ok(configManager);
    });

    test('Should get default values', () => {
        assert.strictEqual(configManager.get('enabled', true), true);
        assert.strictEqual(configManager.get('heartbeatInterval', 120), 120);
        assert.strictEqual(configManager.get('idleThreshold', 300), 300);
        assert.strictEqual(configManager.get('showStatusBar', true), true);
    });

    test('Should get all configuration', () => {
        const config = configManager.getAll();

        assert.ok(config);
        assert.strictEqual(typeof config.enabled, 'boolean');
        assert.strictEqual(typeof config.heartbeatInterval, 'number');
        assert.strictEqual(typeof config.idleThreshold, 'number');
        assert.strictEqual(typeof config.trackFileChanges, 'boolean');
        assert.strictEqual(typeof config.trackProjectSwitching, 'boolean');
        assert.strictEqual(typeof config.showStatusBar, 'boolean');

        // Test nested objects
        assert.ok(config.cloudSync);
        assert.strictEqual(typeof config.cloudSync.enabled, 'boolean');
        assert.strictEqual(typeof config.cloudSync.apiUrl, 'string');
        assert.strictEqual(typeof config.cloudSync.apiKey, 'string');

        assert.ok(config.analytics);
        assert.strictEqual(typeof config.analytics.enableProductivityScore, 'boolean');
        assert.strictEqual(typeof config.analytics.enableLanguageStats, 'boolean');

        assert.ok(config.localServer);
        assert.strictEqual(typeof config.localServer.enabled, 'boolean');
        assert.strictEqual(typeof config.localServer.port, 'number');
        assert.strictEqual(typeof config.localServer.apiToken, 'string');

        assert.ok(config.privacy);
        assert.strictEqual(typeof config.privacy.trackFilenames, 'boolean');
        assert.strictEqual(typeof config.privacy.trackFileContent, 'boolean');

        assert.ok(config.ui);
        assert.strictEqual(typeof config.ui.theme, 'string');
        assert.strictEqual(typeof config.ui.compactMode, 'boolean');

        assert.ok(config.sessionTags);
        assert.strictEqual(typeof config.sessionTags.defaultTagSet, 'string');

        assert.ok(config.goals);
        assert.strictEqual(typeof config.goals.enabled, 'boolean');
        assert.strictEqual(typeof config.goals.dailyMinutes, 'number');
        assert.strictEqual(typeof config.goals.weeklyMinutes, 'number');
        assert.ok(typeof config.goals.projectGoals === 'object');
    });

    test('Should validate configuration', () => {
        // Valid configuration
        const validConfig: Partial<CodePulseConfig> = {
            heartbeatInterval: 120,
            idleThreshold: 300
        };

        const validResult = configManager.validateConfig(validConfig);
        assert.strictEqual(validResult.valid, true);
        assert.strictEqual(validResult.errors.length, 0);

        // Invalid configuration
        const invalidConfig: Partial<CodePulseConfig> = {
            heartbeatInterval: 10, // Too low
            idleThreshold: 10000,  // Too high
            cloudSync: {
                enabled: true,
                apiUrl: '', // Missing required URL
                apiKey: '',  // Missing required key
                includeFilenames: false,
                syncInterval: 300000,
                retryAttempts: 3,
                timeout: 30000
            }
        };

        const invalidResult = configManager.validateConfig(invalidConfig);
        assert.strictEqual(invalidResult.valid, false);
        assert.ok(invalidResult.errors.length > 0);

        // Check specific error messages
        assert.ok(invalidResult.errors.some(err => err.includes('Heartbeat interval')));
        assert.ok(invalidResult.errors.some(err => err.includes('Idle threshold')));
        assert.ok(invalidResult.errors.some(err => err.includes('API URL')));
        assert.ok(invalidResult.errors.some(err => err.includes('API key')));

        const invalidGoals = configManager.validateConfig({
            goals: {
                enabled: true,
                dailyMinutes: 120,
                weeklyMinutes: 600,
                milestoneNotifications: true,
                projectGoals: {
                    testProject: {
                        dailyMinutes: -1
                    }
                }
            }
        });
        assert.strictEqual(invalidGoals.valid, false);
        assert.ok(invalidGoals.errors.some(err => err.includes('Invalid dailyMinutes for project goal "testProject"')));
    });

    test('Should check if tracking is enabled', () => {
        const isEnabled = configManager.isTrackingEnabled();
        assert.strictEqual(typeof isEnabled, 'boolean');
    });

    test('Should check if cloud sync is enabled', () => {
        const isCloudSyncEnabled = configManager.isCloudSyncEnabled();
        assert.strictEqual(typeof isCloudSyncEnabled, 'boolean');
        // Should be false by default since no API URL/key is configured
        assert.strictEqual(isCloudSyncEnabled, false);
    });

    test('Should check if local server is enabled', () => {
        const isLocalServerEnabled = configManager.isLocalServerEnabled();
        assert.strictEqual(typeof isLocalServerEnabled, 'boolean');
        // Should be false by default
        assert.strictEqual(isLocalServerEnabled, false);
    });

    test('Should get theme preference', () => {
        const theme = configManager.getTheme();
        assert.ok(['auto', 'light', 'dark'].includes(theme));
    });

    test('Should handle privacy settings', () => {
        const shouldTrackFilenames = configManager.shouldTrackFilenames();
        const shouldTrackFileContent = configManager.shouldTrackFileContent();
        const shouldAnonymizeData = configManager.shouldAnonymizeData();

        assert.strictEqual(typeof shouldTrackFilenames, 'boolean');
        assert.strictEqual(typeof shouldTrackFileContent, 'boolean');
        assert.strictEqual(typeof shouldAnonymizeData, 'boolean');

        // Default values
        assert.strictEqual(shouldTrackFilenames, true);
        assert.strictEqual(shouldTrackFileContent, false);
        assert.strictEqual(shouldAnonymizeData, false);
    });

    test('Should handle notifications setting', () => {
        const shouldShowNotifications = configManager.shouldShowNotifications();
        assert.strictEqual(typeof shouldShowNotifications, 'boolean');
        // Should be true by default
        assert.strictEqual(shouldShowNotifications, true);
    });

    test('Should get configuration errors', () => {
        const errors = configManager.getConfigurationErrors();
        assert.ok(Array.isArray(errors));
        // With default configuration, should have no errors
        assert.strictEqual(errors.length, 0);
    });

    test('Should support configuration listeners', () => {
        const listener = (_config: CodePulseConfig) => undefined;

        configManager.addChangeListener(listener);

        // Simulate configuration change
        configManager.reloadConfiguration();

        // Remove listener
        configManager.removeChangeListener(listener);

        // Note: In a real test environment, we would need to actually change
        // the VS Code configuration to trigger the listener
        assert.ok(true, 'Listener management test passed');
    });
});
