import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from '../utils/ConfigManager';
import { TimeTracker } from '../tracker/TimeTracker';
import { DatabaseManager } from '../storage/DatabaseManager';
import { DaemonClient } from '../client/DaemonClient';
import {
    TerminalAiDetector,
    TERMINAL_RUNNING_GRACE_POLLS,
    TERMINAL_SCAN_INTERVAL_MS
} from '../detectors/TerminalAiDetector';
import { AiExtensionDetector, AiExtensionInfo } from '../detectors/AiExtensionDetector';

export type AiToolStatus = 'terminal' | 'running' | 'idle';

/**
 * Recency window for treating a daemon AI session as "running now". An open
 * session (isActive) whose lastActivityAt is older than this is shown as idle,
 * not running — mirrors the desktop's findRunningTools so a detection-only
 * session left open on the daemon does not report 'running' forever.
 */
const RUNNING_NOW_WINDOW_MS = 10 * 60 * 1000;

/** Per-tool row rendered by the dashboard's AI Tools card. Time fields are milliseconds. */
export interface AiToolDashboardRow {
    tool: string;
    status: AiToolStatus;
    activeMsToday: number;
    runMsToday: number;
    inputTokens: number;
    outputTokens: number;
}

export interface AiDashboardData {
    tools: AiToolDashboardRow[];
    extensions: AiExtensionInfo[];
    daemonAvailable: boolean;
}

/** Live AI data sources wired in by extension.ts whenever daemon integration is enabled. */
export interface AiDashboardSources {
    daemonClient?: DaemonClient;
    terminalDetector?: TerminalAiDetector;
    extensionDetector?: AiExtensionDetector;
}

export class WebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codepulse.stats';
    private _view?: vscode.WebviewView;
    private _dashboardPanels: Set<vscode.WebviewPanel> = new Set();
    private activeTagFilter: string | null = null;
    private aiSources: AiDashboardSources | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private timeTracker: TimeTracker,
        private databaseManager: DatabaseManager,
        private configManager: ConfigManager
    ) {
        this.registerCommands();
    }

    private registerCommands() {
        this.context.subscriptions.push(
            vscode.commands.registerCommand('codepulse.addSessionTag', async () => {
                await this.executeAddSessionTagCommand();
            }),
            vscode.commands.registerCommand('codepulse.clearSessionTags', async () => {
                await this.executeClearSessionTagsCommand();
            }),
            vscode.commands.registerCommand('codepulse.filterByTag', async () => {
                await this.executeFilterByTagCommand();
            }),
            vscode.commands.registerCommand('codepulse.showGoals', async () => {
                await this.showDashboard();
            })
        );
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this.context.extensionUri,
                vscode.Uri.file(path.join(this.context.extensionPath, 'webview'))
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            message => {
                this.handleWebviewMessage(message);
            },
            undefined,
            this.context.subscriptions
        );

        // Refresh data when webview becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.refreshData();
            }
        });

        // Initial data load
        this.refreshData();
    }

    public async showDashboard() {
        // Create or show the full dashboard in a new webview panel
        const panel = vscode.window.createWebviewPanel(
            'codepulse.dashboard',
            'Code Pulse Dashboard',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    this.context.extensionUri,
                    vscode.Uri.file(path.join(this.context.extensionPath, 'webview'))
                ]
            }
        );

        panel.webview.html = this._getFullDashboardHtml(panel.webview);

        // Track this panel so we can broadcast updates to it
        this._dashboardPanels.add(panel);
        panel.onDidDispose(
            () => {
                this._dashboardPanels.delete(panel);
            },
            undefined,
            this.context.subscriptions
        );

        // Handle messages from the dashboard
        panel.webview.onDidReceiveMessage(
            message => {
                this.handleWebviewMessage(message, panel.webview);
            },
            undefined,
            this.context.subscriptions
        );

        // Load full dashboard data
        await this.loadFullDashboardData(panel.webview);
    }

    public async refresh(): Promise<void> {
        await this.refreshData();
        await this.broadcastToDashboards();
    }

    /** Called by extension.ts when daemon integration is (re)wired or disabled. */
    public setAiSources(sources: AiDashboardSources | undefined): void {
        this.aiSources = sources;
    }

    private async broadcastToDashboards(): Promise<void> {
        const panels = Array.from(this._dashboardPanels);
        await Promise.all(panels.map(p => this.loadFullDashboardData(p.webview)));
    }

    private async handleWebviewMessage(message: any, webview?: vscode.Webview) {
        switch (message.command) {
            case 'getData':
                await this.refreshData();
                break;

            case 'getFullData':
                if (webview) {
                    await this.loadFullDashboardData(webview);
                }
                break;

            case 'showDashboard':
                await this.showDashboard();
                break;

            case 'toggleTracking':
                await this.timeTracker.toggleTracking();
                // Broadcast to sidebar + all open dashboard panels
                await this.refresh();
                break;

            case 'showTodayStats':
                await this.timeTracker.showTodaysStats();
                break;

            case 'exportData':
                await this.timeTracker.exportData();
                break;

            case 'refreshData':
                await this.refreshData();
                break;

            case 'addSessionTag':
                if (Array.isArray(message.tags)) {
                    try {
                        await this.timeTracker.addTagsToCurrentSession(message.tags);
                        await this.refresh();
                    } catch (error) {
                        console.error('Failed to add session tags:', error);
                        const err = error instanceof Error ? error.message : 'Failed to add tags';
                        void vscode.window.showErrorMessage(`Code Pulse: ${err}`);
                    }
                }
                break;

            case 'clearSessionTags':
                try {
                    await this.timeTracker.clearCurrentSessionTags();
                    await this.refresh();
                } catch (error) {
                    console.error('Failed to clear session tags:', error);
                    const err = error instanceof Error ? error.message : 'Failed to clear tags';
                    void vscode.window.showErrorMessage(`Code Pulse: ${err}`);
                }
                break;

            case 'filterByTag':
                this.applyTagFilter(message.tag);
                break;

            case 'setLocalTagFilter':
                this.applyTagFilter(message.data?.tag);
                break;

            case 'getDateRangeData':
                await this.getDateRangeData(message.startDate, message.endDate, webview);
                break;

            case 'getProjectStats':
                await this.getProjectStats(webview);
                break;

            case 'getLanguageStats':
                await this.getLanguageStats(webview);
                break;

            case 'getAllSessions':
                await this.getAllSessions(message.days ?? 0, webview);
                break;
        }
    }

    private async getAllSessions(days: number, webview?: vscode.Webview) {
        try {
            const endDate = new Date();
            const startDate = new Date();
            if (days > 0) {
                startDate.setDate(endDate.getDate() - days);
            } else {
                startDate.setFullYear(2000); // "all time"
            }

            const sessions = await this.databaseManager.getSessionsByDateRange(startDate, endDate);
            const target = webview ?? this._view?.webview;
            target?.postMessage({ command: 'updateAllSessions', data: { sessions, days } });
        } catch (error) {
            console.error('Failed to get all sessions:', error);
        }
    }

    private async refreshData() {
        if (!this._view) {
            return;
        }

        try {
            const currentSession = this.timeTracker.getCurrentSession();
            const todayStats = await this.timeTracker.getTodaysStats();
            const weeklyStats = await this.timeTracker.getWeeklyStats();
            const settings = this.getWebviewSettings();

            this._view.webview.postMessage({
                command: 'updateData',
                data: {
                    currentSession,
                    todayStats,
                    weeklyStats,
                    isTracking: currentSession?.isActive || false,
                    isIdle: this.timeTracker.isIdle(),
                    settings
                }
            });
        } catch (error) {
            console.error('Failed to refresh webview data:', error);
        }
    }

    private async loadFullDashboardData(webview: vscode.Webview) {
        try {
            const currentSession = this.timeTracker.getCurrentSession();
            const todayStats = await this.timeTracker.getTodaysStats();
            const weeklyStats = await this.timeTracker.getWeeklyStats();

            // Get additional analytics data
            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(endDate.getDate() - 30); // Last 30 days

            const sessions = await this.databaseManager.getSessionsByDateRange(startDate, endDate);
            const activities = await this.databaseManager.getActivitiesByDateRange(startDate, endDate);
            const projectStats = this.configManager.get('analytics.enableProjectStats', true)
                ? await this.databaseManager.getTotalTimeByProject(startDate, endDate)
                : {};
            const languageStats = this.configManager.get('analytics.enableLanguageStats', true)
                ? await this.databaseManager.getTotalTimeByLanguage(startDate, endDate)
                : {};
            const goalProgress = await this.timeTracker.getGoalProgress();
            const settings = this.getWebviewSettings();

            webview.postMessage({
                command: 'updateFullData',
                data: {
                    currentSession,
                    todayStats,
                    weeklyStats,
                    sessions,
                    activities,
                    projectStats,
                    languageStats,
                    activeTagFilter: this.activeTagFilter,
                    isTracking: currentSession?.isActive || false,
                    isIdle: this.timeTracker.isIdle(),
                    goalProgress,
                    settings
                }
            });

            // AI data rides the same refresh cycle but is posted separately so a
            // slow/unreachable daemon never delays the main dashboard payload.
            void this.sendAiData(webview);
        } catch (error) {
            console.error('Failed to load full dashboard data:', error);
        }
    }

    private async sendAiData(webview: vscode.Webview): Promise<void> {
        try {
            const data = await this.buildAiDashboardData();
            webview.postMessage({ command: 'updateAiData', data });
        } catch (error) {
            console.error('Failed to load AI tool data:', error);
        }
    }

    /**
     * Merges today's daemon aggregates (/v1/ai/activity + /v1/ai/sessions) with
     * the local terminal/extension detector state. Daemon-absent, the card still
     * shows locally detected tools with an offline hint (daemonAvailable=false).
     */
    private async buildAiDashboardData(): Promise<AiDashboardData> {
        const daemonClient = this.aiSources?.daemonClient;
        const daemonAvailable = daemonClient?.isDaemonMode() ?? false;
        const byTool = new Map<string, AiToolDashboardRow>();
        const runningOnDaemon = new Set<string>();

        if (daemonClient && daemonAvailable) {
            const [activity, sessions] = await Promise.all([
                daemonClient.getAiActivity(),
                daemonClient.getAiSessions()
            ]);

            const today = formatLocalDay(new Date());
            for (const row of activity.activity ?? []) {
                if (!row.tool || row.day !== today) {
                    continue;
                }

                const entry = byTool.get(row.tool) ?? emptyAiToolRow(row.tool);
                byTool.set(row.tool, {
                    ...entry,
                    activeMsToday: entry.activeMsToday + (row.activeMs ?? 0),
                    runMsToday: entry.runMsToday + (row.runMs ?? 0),
                    inputTokens: entry.inputTokens + (row.inputTokens ?? 0),
                    outputTokens: entry.outputTokens + (row.outputTokens ?? 0)
                });
            }

            const nowMs = Date.now();
            for (const session of sessions.sessions ?? []) {
                if (!session.tool || !session.isActive) {
                    continue;
                }
                const lastActivityMs = Date.parse(session.lastActivityAt ?? '');
                if (Number.isFinite(lastActivityMs) && nowMs - lastActivityMs <= RUNNING_NOW_WINDOW_MS) {
                    runningOnDaemon.add(session.tool);
                }
            }
        }

        // Local terminal detections keep the card alive daemon-absent and drive
        // the 'terminal' status; entries older than the 2-poll grace are pruned
        // by the detector itself.
        const now = Date.now();
        const terminalGraceMs = TERMINAL_SCAN_INTERVAL_MS * TERMINAL_RUNNING_GRACE_POLLS;
        const seenInTerminal = new Set<string>();
        for (const state of this.aiSources?.terminalDetector?.getRunningTools() ?? []) {
            if (now - state.lastSeenAt <= terminalGraceMs) {
                seenInTerminal.add(state.tool);
            }
            if (!byTool.has(state.tool)) {
                byTool.set(state.tool, emptyAiToolRow(state.tool));
            }
        }

        const tools = Array.from(byTool.values())
            .map(row => ({
                ...row,
                status: seenInTerminal.has(row.tool)
                    ? ('terminal' as AiToolStatus)
                    : runningOnDaemon.has(row.tool)
                        ? ('running' as AiToolStatus)
                        : ('idle' as AiToolStatus)
            }))
            .sort((a, b) => b.activeMsToday - a.activeMsToday || a.tool.localeCompare(b.tool));

        return {
            tools,
            extensions: this.aiSources?.extensionDetector?.getInventory() ?? [],
            daemonAvailable
        };
    }

    private async getDateRangeData(startDate: string, endDate: string, webview?: vscode.Webview) {
        try {
            const start = new Date(startDate);
            const end = new Date(endDate);

            const sessions = await this.databaseManager.getSessionsByDateRange(start, end);
            const activities = await this.databaseManager.getActivitiesByDateRange(start, end);
            const projectStats = this.configManager.get('analytics.enableProjectStats', true)
                ? await this.databaseManager.getTotalTimeByProject(start, end)
                : {};
            const languageStats = this.configManager.get('analytics.enableLanguageStats', true)
                ? await this.databaseManager.getTotalTimeByLanguage(start, end)
                : {};

            const targetWebview = webview ?? this._view?.webview;
            if (targetWebview) {
                targetWebview.postMessage({
                    command: 'updateDateRangeData',
                    data: {
                        sessions,
                        activities,
                        projectStats,
                        languageStats,
                        dateRange: { startDate, endDate },
                        tagFilter: this.activeTagFilter
                    }
                });
            }
        } catch (error) {
            console.error('Failed to get date range data:', error);
        }
    }

    private async getProjectStats(webview?: vscode.Webview) {
        try {
            if (!this.configManager.get('analytics.enableProjectStats', true)) {
                const targetWebview = webview ?? this._view?.webview;
                targetWebview?.postMessage({ command: 'updateProjectStats', data: {} });
                return;
            }

            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(endDate.getDate() - 30);

            const projectStats = await this.databaseManager.getTotalTimeByProject(startDate, endDate);

            const targetWebview = webview ?? this._view?.webview;
            if (targetWebview) {
                targetWebview.postMessage({
                    command: 'updateProjectStats',
                    data: projectStats
                });
            }
        } catch (error) {
            console.error('Failed to get project stats:', error);
        }
    }

    private async getLanguageStats(webview?: vscode.Webview) {
        try {
            if (!this.configManager.get('analytics.enableLanguageStats', true)) {
                const targetWebview = webview ?? this._view?.webview;
                targetWebview?.postMessage({ command: 'updateLanguageStats', data: {} });
                return;
            }

            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(endDate.getDate() - 30);

            const languageStats = await this.databaseManager.getTotalTimeByLanguage(startDate, endDate);

            const targetWebview = webview ?? this._view?.webview;
            if (targetWebview) {
                targetWebview.postMessage({
                    command: 'updateLanguageStats',
                    data: languageStats
                });
            }
        } catch (error) {
            console.error('Failed to get language stats:', error);
        }
    }

    private getWebviewSettings(): {
        theme: 'auto' | 'light' | 'dark';
        compactMode: boolean;
        showProjectStats: boolean;
        showLanguageStats: boolean;
        showActivityTracking: boolean;
        defaultTagSet: string;
    } {
        return {
            theme: this.configManager.getTheme(),
            compactMode: this.configManager.get('ui.compactMode', false),
            showProjectStats: this.configManager.get('analytics.enableProjectStats', true),
            showLanguageStats: this.configManager.get('analytics.enableLanguageStats', true),
            showActivityTracking: this.configManager.get('analytics.enableActivityTracking', true),
            defaultTagSet: this.configManager.get(
                'sessionTags.defaultTagSet',
                'deep-work,meeting,bugfix,review,docs'
            )
        };
    }

    private applyTagFilter(tag: string | null | undefined): void {
        if (typeof tag === 'string') {
            const normalized = tag.trim().toLowerCase();
            this.activeTagFilter = normalized.length ? normalized : null;
        } else {
            this.activeTagFilter = null;
        }

        void this.broadcastTagFilterState();
        void this.refresh();
    }

    private async broadcastTagFilterState(): Promise<void> {
        const message = { command: 'setLocalTagFilter', data: { tag: this.activeTagFilter } };

        if (this._view) {
            await this._view.webview.postMessage(message);
        }

        await Promise.all(Array.from(this._dashboardPanels).map(panel => panel.webview.postMessage(message)));
    }

    private async executeAddSessionTagCommand(): Promise<void> {
        const rawTagInput = await vscode.window.showInputBox({
            prompt: 'Add tags to current session (comma separated)',
            placeHolder: 'deep-work, meeting, bugfix, review, docs',
            value: this.configManager.get('sessionTags.defaultTagSet', 'deep-work,meeting,bugfix,review,docs')
        });

        if (rawTagInput === undefined) {
            return;
        }

        const tags = this.parseTagInput(rawTagInput);
        if (tags.length === 0) {
            void vscode.window.showWarningMessage('Code Pulse: No valid tag provided.');
            return;
        }

        try {
            await this.timeTracker.addTagsToCurrentSession(tags);
            await this.refresh();
            void vscode.window.showInformationMessage(`Code Pulse: Added tags: ${tags.join(', ')}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to add tags';
            void vscode.window.showErrorMessage(`Code Pulse: ${message}`);
        }
    }

    private async executeClearSessionTagsCommand(): Promise<void> {
        try {
            await this.timeTracker.clearCurrentSessionTags();
            await this.refresh();
            void vscode.window.showInformationMessage('Code Pulse: Cleared session tags.');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to clear tags';
            void vscode.window.showErrorMessage(`Code Pulse: ${message}`);
        }
    }

    private async executeFilterByTagCommand(): Promise<void> {
        await this.showDashboard();

        const rawTagInput = await vscode.window.showInputBox({
            prompt: 'Filter dashboard sessions and activities by tag',
            placeHolder: 'Type a tag to filter (leave blank to clear)'
        });

        if (rawTagInput === undefined) {
            return;
        }

        this.applyTagFilter(rawTagInput || null);
    }

    private parseTagInput(raw: string): string[] {
        return raw
            .split(',')
            .map(tag => tag.trim().toLowerCase())
            .filter(tag => tag.length > 0)
            .filter((tag, index, tags) => tags.indexOf(tag) === index);
    }

    private getBodyAttributes(): string {
        const classes = [this.configManager.get('ui.compactMode', false) ? 'compact-mode' : ''];
        return `class="${classes.filter(Boolean).join(' ')}" data-theme="${this.configManager.getTheme()}"`;
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const styleVscode = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'vscode.css')
        );
        const styleMain = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'main.css'));
        const scriptMain = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'main.js'));
        const scriptChart = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'chart.min.js')
        );
        const cspSource = webview.cspSource;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; script-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; connect-src ${cspSource}; font-src ${cspSource}; frame-ancestors 'none'; base-uri 'none';">
            <link href="${styleVscode}" rel="stylesheet">
            <link href="${styleMain}" rel="stylesheet">
            <title>Code Pulse</title>
        </head>
        <body ${this.getBodyAttributes()}>
            <div class="container">
                <div class="current-session" id="currentSession">
                    <div class="status-indicator" id="statusIndicator">
                        <span class="status-dot"></span>
                        <span class="status-text">Loading…</span>
                    </div>
                    <div class="session-info">
                        <div class="session-time" id="sessionTime">--:--:--</div>
                        <div class="session-details" id="sessionDetails">No active session</div>
                    </div>
                </div>

                <div class="actions">
                    <button class="btn btn-primary" id="toggleTrackingBtn">Start Tracking</button>
                    <button class="btn" id="dashboardBtn">Dashboard</button>
                </div>

                <div class="today-stats" id="todayStats">
                    <h3>Today</h3>
                    <div class="stat-item">
                        <span class="stat-label">Total Time</span>
                        <span class="stat-value" id="todayTotalTime">0h 0m</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Productivity</span>
                        <span class="stat-value" id="todayProductivity">0%</span>
                    </div>
                </div>

                <div class="quick-stats" id="quickStats">
                    <div class="stat-grid">
                        <div class="stat-card">
                            <div class="stat-number" id="todaySessions">0</div>
                            <div class="stat-label">Sessions</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number" id="todayFiles">0</div>
                            <div class="stat-label">Files</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number" id="todayProjects">0</div>
                            <div class="stat-label">Projects</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number" id="todayLanguages">0</div>
                            <div class="stat-label">Languages</div>
                        </div>
                    </div>
                </div>

                <div class="weekly-chart" id="weeklyChart">
                    <h3>This Week</h3>
                    <canvas id="weeklyCanvas" width="300" height="140"></canvas>
                </div>
            </div>

            <script src="${scriptChart}"></script>
            <script src="${scriptMain}"></script>
        </body>
        </html>`;
    }

    private _getFullDashboardHtml(webview: vscode.Webview): string {
        const styleVscode = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'vscode.css')
        );
        const styleDashboard = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dashboard.css')
        );
        const scriptDashboard = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dashboard.js')
        );
        const scriptChart = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'chart.min.js')
        );
        const cspSource = webview.cspSource;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; script-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; connect-src ${cspSource}; font-src ${cspSource}; frame-ancestors 'none'; base-uri 'none';">
            <link href="${styleVscode}" rel="stylesheet">
            <link href="${styleDashboard}" rel="stylesheet">
            <title>Code Pulse Dashboard</title>
        </head>
        <body ${this.getBodyAttributes()}>
            <div class="dashboard-container">
                <header class="dashboard-header">
                    <div class="header-content">
                        <h1 class="dashboard-title">Code Pulse Dashboard</h1>
                        <div class="header-actions">
                            <div class="status-indicator" id="statusIndicator">
                                <span class="status-dot"></span>
                                <span class="status-text">Loading...</span>
                            </div>
                            <button class="btn btn-primary" id="toggleTrackingBtn">Start Tracking</button>
                        </div>
                    </div>
                </header>

                <main class="dashboard-main">
                    <div class="dashboard-grid">
                        <!-- Current Session Card -->
                        <div class="card current-session-card">
                            <h2 class="card-title">Current Session</h2>
                            <div class="current-session-content" id="currentSessionContent">
                                <div class="session-timer" id="sessionTimer">--:--:--</div>
                                <div class="session-info" id="sessionInfo">No active session</div>
                            </div>
                        </div>

                        <!-- Today Stats Card -->
                        <div class="card stats-card">
                            <h2 class="card-title">Today's Stats</h2>
                            <div class="stats-grid" id="todayStatsGrid">
                                <div class="stat-item">
                                    <div class="stat-value" id="todayTotalTime">0h 0m</div>
                                    <div class="stat-label">Total Time</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-value" id="todayActiveTime">0h 0m</div>
                                    <div class="stat-label">Active Time</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-value" id="todayProductivity">0%</div>
                                    <div class="stat-label">Productivity</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-value" id="todaySessions">0</div>
                                    <div class="stat-label">Sessions</div>
                                </div>
                            </div>
                        </div>

                        <div class="card goals-card">
                            <h2 class="card-title">Goal Progress</h2>
                            <div class="goal-overview" id="goalOverview">
                                <div class="goal-group">
                                    <div class="goal-group-title">Global</div>
                                    <div class="goal-metric" id="globalDailyGoal">
                                        <div class="goal-metric-label">Daily</div>
                                        <div class="goal-metric-value">Not set</div>
                                        <div class="goal-metric-detail">—</div>
                                    </div>
                                    <div class="goal-metric" id="globalWeeklyGoal">
                                        <div class="goal-metric-label">Weekly</div>
                                        <div class="goal-metric-value">Not set</div>
                                        <div class="goal-metric-detail">—</div>
                                    </div>
                                </div>
                                <div class="goal-group">
                                    <div class="goal-group-title">Project</div>
                                    <div class="goal-group-subtitle" id="goalProjectName">No project selected</div>
                                    <div class="goal-metric" id="projectDailyGoal">
                                        <div class="goal-metric-label">Daily</div>
                                        <div class="goal-metric-value">Not set</div>
                                        <div class="goal-metric-detail">—</div>
                                    </div>
                                    <div class="goal-metric" id="projectWeeklyGoal">
                                        <div class="goal-metric-label">Weekly</div>
                                        <div class="goal-metric-value">Not set</div>
                                        <div class="goal-metric-detail">—</div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Weekly Chart Card -->
                        <div class="card chart-card">
                            <h2 class="card-title">Weekly Overview</h2>
                            <div class="chart-container">
                                <canvas id="weeklyChart" width="400" height="200"></canvas>
                            </div>
                        </div>

                        <!-- Project Breakdown Card -->
                        <div class="card breakdown-card">
                            <h2 class="card-title">Projects (Last 30 Days)</h2>
                            <div class="breakdown-content" id="projectBreakdown">
                                <div class="chart-container">
                                    <canvas id="projectChart" width="300" height="300"></canvas>
                                </div>
                                <div class="breakdown-list" id="projectList"></div>
                            </div>
                        </div>

                        <!-- Language Breakdown Card -->
                        <div class="card breakdown-card">
                            <h2 class="card-title">Languages (Last 30 Days)</h2>
                            <div class="breakdown-content" id="languageBreakdown">
                                <div class="chart-container">
                                    <canvas id="languageChart" width="300" height="300"></canvas>
                                </div>
                                <div class="breakdown-list" id="languageList"></div>
                            </div>
                        </div>

                        <!-- AI Tools Card -->
                        <div class="card breakdown-card ai-tools-card">
                            <h2 class="card-title">AI Tools (Today)</h2>
                            <div class="ai-offline-hint" id="aiOfflineHint" hidden>
                                Daemon offline — showing local detections only
                            </div>
                            <div class="breakdown-list ai-tools-list" id="aiToolsList">
                                <div class="loading-cell">Loading…</div>
                            </div>
                            <div class="ai-extensions-title">AI Extensions</div>
                            <div class="breakdown-list ai-extensions-list" id="aiExtensionsList">
                                <div class="loading-cell">Loading…</div>
                            </div>
                        </div>

                        <!-- Sessions Table Card -->
                        <div class="card sessions-card">
                            <div class="sessions-header">
                                <h2 class="card-title">All Sessions</h2>
                                <span class="sessions-count" id="sessionsCount">—</span>
                            </div>
                            <div class="sessions-filters">
                                <input type="search" id="sessionSearch" class="filter-input" placeholder="Search file, branch…" />
                                <select id="sessionTagFilter" class="filter-input">
                                    <option value="">All tags</option>
                                </select>
                                <select id="sessionProjectFilter" class="filter-input">
                                    <option value="">All projects</option>
                                </select>
                                <select id="sessionLanguageFilter" class="filter-input">
                                    <option value="">All languages</option>
                                </select>
                                <select id="sessionDateRange" class="filter-input">
                                    <option value="7">Last 7 days</option>
                                    <option value="30" selected>Last 30 days</option>
                                    <option value="90">Last 90 days</option>
                                    <option value="365">Last year</option>
                                    <option value="0">All time</option>
                                </select>
                                <button class="btn btn-secondary" id="sessionClearBtn" type="button">Clear</button>
                            </div>
                            <div class="quick-command-row">
                                <input
                                    type="search"
                                    id="quickCommandInput"
                                    class="filter-input"
                                    placeholder="Quick command: /tag deep-work,bugfix | /filter meeting"
                                />
                                <button class="btn btn-secondary" id="quickCommandBtn" type="button">Run</button>
                                <span class="session-filter-hint">Quick commands: /tag, /filter, /clear-tags</span>
                            </div>
                            <div class="sessions-table-wrapper">
                                <table class="sessions-table" id="sessionsTable">
                                    <thead>
                                        <tr>
                                            <th data-sort="startTime" class="sortable">Date <span class="sort-arrow"></span></th>
                                            <th data-sort="project" class="sortable">Project <span class="sort-arrow"></span></th>
                                            <th data-sort="language" class="sortable">Lang <span class="sort-arrow"></span></th>
                                            <th data-sort="file">File</th>
                                            <th data-sort="tags">Tags</th>
                                            <th data-sort="branch">Branch</th>
                                            <th data-sort="duration" class="sortable num">Time <span class="sort-arrow"></span></th>
                                            <th data-sort="productivityScore" class="sortable num">Score <span class="sort-arrow"></span></th>
                                        </tr>
                                    </thead>
                                    <tbody id="sessionsTableBody">
                                        <tr><td colspan="8" class="loading-cell">Loading…</td></tr>
                                    </tbody>
                                </table>
                            </div>
                            <div class="sessions-pagination">
                                <button class="btn btn-secondary" id="sessionPrevBtn" type="button">← Prev</button>
                                <span class="pagination-info" id="sessionPageInfo">Page 1 of 1</span>
                                <button class="btn btn-secondary" id="sessionNextBtn" type="button">Next →</button>
                            </div>
                        </div>

                        <!-- Recent Activity Card -->
                        <div class="card activity-card">
                            <h2 class="card-title">Recent Activity</h2>
                            <div class="activity-list" id="activityList">
                                <div class="activity-item">
                                    <div class="activity-time">Loading...</div>
                                    <div class="activity-description">Fetching recent activity...</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </main>
            </div>

            <script src="${scriptChart}"></script>
            <script src="${scriptDashboard}"></script>
        </body>
        </html>`;
    }
}

/** Local calendar day (YYYY-MM-DD) — matches the daemon's per-day aggregation key. */
function formatLocalDay(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function emptyAiToolRow(tool: string): AiToolDashboardRow {
    return {
        tool,
        status: 'idle',
        activeMsToday: 0,
        runMsToday: 0,
        inputTokens: 0,
        outputTokens: 0
    };
}
