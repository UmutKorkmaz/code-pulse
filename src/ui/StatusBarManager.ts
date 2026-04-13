import * as vscode from 'vscode';
import { TimeTracker } from '../tracker/TimeTracker';
import { ConfigManager } from '../utils/ConfigManager';

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private updateTimer: NodeJS.Timeout | null = null;
    private isVisible = true;

    constructor(
        private timeTracker: TimeTracker,
        private configManager: ConfigManager
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.isVisible = this.configManager.get('showStatusBar', true);

        if (this.isVisible) {
            this.startPeriodicUpdate();
        }

        this.updateStatusBar();
    }

    public updateStatusBar(): void {
        if (!this.isVisible || !this.configManager.isEnabled()) {
            this.statusBarItem.hide();
            return;
        }

        const currentSession = this.timeTracker.getCurrentSession();

        if (currentSession && currentSession.isActive) {
            this.showActiveStatus(currentSession);
        } else {
            this.showInactiveStatus();
        }

        this.statusBarItem.show();
    }

    public show(): void {
        this.isVisible = true;
        this.updateStatusBar();
        this.startPeriodicUpdate();
    }

    public hide(): void {
        this.isVisible = false;
        this.statusBarItem.hide();
        this.stopPeriodicUpdate();
    }

    public toggle(): void {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    public setVisible(visible: boolean): void {
        if (visible) {
            this.show();
        } else {
            this.hide();
        }
    }

    public dispose(): void {
        this.stopPeriodicUpdate();
        this.statusBarItem.dispose();
    }

    public async showTodaysTime(): Promise<void> {
        try {
            const stats = await this.timeTracker.getTodaysStats();
            const totalHours = Math.floor(stats.totalTime / (1000 * 60 * 60));
            const totalMinutes = Math.floor((stats.totalTime % (1000 * 60 * 60)) / (1000 * 60));

            const message = `Today's coding time: ${totalHours}h ${totalMinutes}m`;
            vscode.window.showInformationMessage(message);

        } catch (error) {
            vscode.window.showErrorMessage('Failed to load today\'s statistics.');
        }
    }

    private showActiveStatus(session: any): void {
        const duration = this.timeTracker.getLiveSessionDuration();
        const timeString = this.formatDuration(duration);

        // Different icons based on productivity or activity
        let icon = '$(pulse)';
        if (session.productivityScore && session.productivityScore > 80) {
            icon = '$(flame)'; // High productivity
        } else if (this.timeTracker.isIdle()) {
            icon = '$(circle-outline)'; // Idle
        }

        this.statusBarItem.text = `${icon} ${timeString}`;
        this.statusBarItem.tooltip = this.buildActiveTooltip(session, duration);
        this.statusBarItem.command = 'codepulse.showDashboard';
        this.statusBarItem.backgroundColor = undefined; // Clear any error background
    }

    private showInactiveStatus(): void {
        this.statusBarItem.text = this.configManager.isEnabled() ? '$(pulse) CodePulse' : '$(circle-slash) CodePulse Off';
        this.statusBarItem.tooltip = this.configManager.isEnabled()
            ? 'CodePulse: Click to start tracking or view dashboard'
            : 'CodePulse is disabled in settings';
        this.statusBarItem.command = 'codepulse.showDashboard';
        this.statusBarItem.backgroundColor = this.configManager.isEnabled()
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
    }

    private buildActiveTooltip(session: any, duration: number): string {
        const timeString = this.formatDuration(duration);
        const project = session.project || 'Unknown Project';
        const language = session.language || 'Unknown Language';
        const file = this.getShortFileName(session.file);

        let tooltip = `CodePulse: Active Session\n`;
        tooltip += `⏱️ Time: ${timeString}\n`;
        tooltip += `📁 Project: ${project}\n`;
        tooltip += `🔤 Language: ${language}\n`;
        tooltip += `📄 File: ${file}\n`;

        if (session.heartbeats > 0) {
            tooltip += `💓 Heartbeats: ${session.heartbeats}\n`;
        }

        if (session.keystrokes > 0) {
            tooltip += `⌨️ Keystrokes: ${session.keystrokes}\n`;
        }

        if (session.productivityScore !== undefined && session.productivityScore !== null) {
            tooltip += `📈 Productivity: ${Math.round(session.productivityScore)}%\n`;
        }

        tooltip += `\n💡 Click to view dashboard`;

        return tooltip;
    }

    private formatDuration(milliseconds: number): string {
        const totalSeconds = Math.floor(milliseconds / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
            return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }

    private getShortFileName(filePath: string): string {
        if (!filePath) {
            return 'Untitled';
        }

        const fileName = filePath.split(/[/\\]/).pop() || 'Untitled';

        // Truncate long file names
        if (fileName.length > 30) {
            return fileName.substring(0, 27) + '...';
        }

        return fileName;
    }

    private startPeriodicUpdate(): void {
        this.stopPeriodicUpdate();

        // Update every second when active
        this.updateTimer = setInterval(() => {
            this.updateStatusBar();
        }, 1000);
    }

    private stopPeriodicUpdate(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
    }

    // Public methods for external control
    public refreshConfiguration(): void {
        const shouldShow = this.configManager.get('showStatusBar', true);
        this.setVisible(shouldShow);
    }

    public showErrorStatus(message: string): void {
        this.statusBarItem.text = '$(error) CodePulse Error';
        this.statusBarItem.tooltip = `CodePulse Error: ${message}\nClick for more details`;
        this.statusBarItem.command = 'codepulse.showDashboard';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.statusBarItem.show();
    }

    public showWarningStatus(message: string): void {
        this.statusBarItem.text = '$(warning) CodePulse';
        this.statusBarItem.tooltip = `CodePulse Warning: ${message}\nClick for more details`;
        this.statusBarItem.command = 'codepulse.showDashboard';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.statusBarItem.show();
    }

    public clearErrorStatus(): void {
        this.statusBarItem.backgroundColor = undefined;
        this.updateStatusBar();
    }

    public showSyncStatus(isSyncing: boolean): void {
        if (!this.isVisible) {
            return;
        }

        const currentSession = this.timeTracker.getCurrentSession();

        if (isSyncing) {
            if (currentSession && currentSession.isActive) {
                const duration = this.timeTracker.getLiveSessionDuration();
                const timeString = this.formatDuration(duration);
                this.statusBarItem.text = `$(sync~spin) ${timeString}`;
                this.statusBarItem.tooltip = 'CodePulse: Syncing to cloud...\n' + this.buildActiveTooltip(currentSession, duration);
            } else {
                this.statusBarItem.text = '$(sync~spin) CodePulse';
                this.statusBarItem.tooltip = 'CodePulse: Syncing to cloud...';
            }
        } else {
            this.updateStatusBar(); // Restore normal status
        }
    }

    public async showQuickStats(): Promise<void> {
        try {
            const stats = await this.timeTracker.getTodaysStats();
            const totalHours = Math.floor(stats.totalTime / (1000 * 60 * 60));
            const totalMinutes = Math.floor((stats.totalTime % (1000 * 60 * 60)) / (1000 * 60));

            const topProject = Object.keys(stats.projects).length > 0
                ? Object.keys(stats.projects).reduce((a, b) => stats.projects[a] > stats.projects[b] ? a : b)
                : 'n/a';
            const topLanguage = Object.keys(stats.languages).length > 0
                ? Object.keys(stats.languages).reduce((a, b) => stats.languages[a] > stats.languages[b] ? a : b)
                : 'n/a';

            const quickStats = [
                `⏱️ ${totalHours}h ${totalMinutes}m today`,
                `📁 ${topProject}`,
                `🔤 ${topLanguage}`,
                `📈 ${Math.round(stats.productivity.score)}% productivity`
            ].join(' | ');

            await vscode.window.showInformationMessage(quickStats, 'View Dashboard').then(selection => {
                if (selection === 'View Dashboard') {
                    vscode.commands.executeCommand('codepulse.showDashboard');
                }
            });

        } catch (error) {
            vscode.window.showErrorMessage('Failed to load quick statistics.');
        }
    }
}
