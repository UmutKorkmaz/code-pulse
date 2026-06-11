import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    test('Sample test', () => {
        assert.strictEqual(-1, [1, 2, 3].indexOf(5));
        assert.strictEqual(-1, [1, 2, 3].indexOf(0));
    });

    test('Extension should be present', () => {
        assert.ok(vscode.extensions.getExtension('umutkorkmaz.codepulse'));
    });

    test('Extension should activate', async () => {
        const extension = vscode.extensions.getExtension('umutkorkmaz.codepulse');
        assert.ok(extension);

        if (!extension.isActive) {
            await extension.activate();
        }

        assert.strictEqual(extension.isActive, true);
    });

    test('Commands should be registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        const codePulseCommands = commands.filter(cmd => cmd.startsWith('codepulse.'));

        assert.ok(codePulseCommands.length > 0, 'No CodePulse commands found');

        // Check for essential commands
        const expectedCommands = [
            'codepulse.showDashboard',
            'codepulse.showGoals',
            'codepulse.toggleTracking',
            'codepulse.toggleFocusSession',
            'codepulse.showStats',
            'codepulse.exportData',
            'codepulse.resetData',
            'codepulse.addSessionTag',
            'codepulse.clearSessionTags',
            'codepulse.filterByTag'
        ];

        expectedCommands.forEach(cmd => {
            assert.ok(
                codePulseCommands.includes(cmd),
                `Command ${cmd} not found`
            );
        });
    });

    test('Configuration should be available', () => {
        const config = vscode.workspace.getConfiguration('codepulse');
        assert.ok(config);

        // Test default values
        assert.strictEqual(config.get('enabled'), true);
        assert.strictEqual(config.get('heartbeatInterval'), 120);
        assert.strictEqual(config.get('idleThreshold'), 300);
        assert.strictEqual(config.get('showStatusBar'), true);
        assert.strictEqual(config.get('sessionTags.defaultTagSet'), 'deep-work,meeting,bugfix,review,docs');
        assert.strictEqual(config.get('goals.enabled'), true);
        assert.strictEqual(config.get('goals.dailyMinutes'), 0);
        assert.strictEqual(config.get('localServer.apiToken'), '');
    });

    test('Status bar item should be available', async () => {
        const extension = vscode.extensions.getExtension('umutkorkmaz.codepulse');
        assert.ok(extension);

        if (!extension.isActive) {
            await extension.activate();
        }

        // Note: Testing status bar items requires more complex setup
        // This is a placeholder for more detailed testing
        assert.ok(true, 'Status bar item test placeholder');
    });

    test('Webview provider should be registered', async () => {
        const extension = vscode.extensions.getExtension('umutkorkmaz.codepulse');
        assert.ok(extension);

        if (!extension.isActive) {
            await extension.activate();
        }

        // Note: Testing webview providers requires more complex setup
        // This is a placeholder for more detailed testing
        assert.ok(true, 'Webview provider test placeholder');
    });
});
