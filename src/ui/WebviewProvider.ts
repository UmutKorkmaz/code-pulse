import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from '../utils/ConfigManager';
import { TimeTracker } from '../tracker/TimeTracker';
import { DatabaseManager } from '../storage/DatabaseManager';

export class WebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codepulse.stats';
    private _view?: vscode.WebviewView;
    private _dashboardPanels: Set<vscode.WebviewPanel> = new Set();

    constructor(
        private context: vscode.ExtensionContext,
        private timeTracker: TimeTracker,
        private databaseManager: DatabaseManager,
        private configManager: ConfigManager
    ) {}

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
                    isTracking: currentSession?.isActive || false,
                    isIdle: this.timeTracker.isIdle(),
                    settings
                }
            });
        } catch (error) {
            console.error('Failed to load full dashboard data:', error);
        }
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
                        dateRange: { startDate, endDate }
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
    } {
        return {
            theme: this.configManager.getTheme(),
            compactMode: this.configManager.get('ui.compactMode', false),
            showProjectStats: this.configManager.get('analytics.enableProjectStats', true),
            showLanguageStats: this.configManager.get('analytics.enableLanguageStats', true),
            showActivityTracking: this.configManager.get('analytics.enableActivityTracking', true)
        };
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

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
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

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
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

                        <!-- Sessions Table Card -->
                        <div class="card sessions-card">
                            <div class="sessions-header">
                                <h2 class="card-title">All Sessions</h2>
                                <span class="sessions-count" id="sessionsCount">—</span>
                            </div>
                            <div class="sessions-filters">
                                <input type="search" id="sessionSearch" class="filter-input" placeholder="Search file, branch…" />
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
                            <div class="sessions-table-wrapper">
                                <table class="sessions-table" id="sessionsTable">
                                    <thead>
                                        <tr>
                                            <th data-sort="startTime" class="sortable">Date <span class="sort-arrow"></span></th>
                                            <th data-sort="project" class="sortable">Project <span class="sort-arrow"></span></th>
                                            <th data-sort="language" class="sortable">Lang <span class="sort-arrow"></span></th>
                                            <th data-sort="file">File</th>
                                            <th data-sort="branch">Branch</th>
                                            <th data-sort="duration" class="sortable num">Time <span class="sort-arrow"></span></th>
                                            <th data-sort="productivityScore" class="sortable num">Score <span class="sort-arrow"></span></th>
                                        </tr>
                                    </thead>
                                    <tbody id="sessionsTableBody">
                                        <tr><td colspan="7" class="loading-cell">Loading…</td></tr>
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
