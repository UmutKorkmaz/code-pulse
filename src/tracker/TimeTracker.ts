import * as vscode from 'vscode';
import { AnalyticsEngine } from '../analytics/AnalyticsEngine';
import { LanguageDetector } from '../detectors/LanguageDetector';
import { ProjectDetector } from '../detectors/ProjectDetector';
import { CloudSync } from '../storage/CloudSync';
import { DatabaseManager } from '../storage/DatabaseManager';
import { ConfigManager } from '../utils/ConfigManager';
import { formatLocalDate, startOfLocalDay } from '../utils/DateUtils';
import { Logger } from '../utils/Logger';
import { sanitizeFilePath, sanitizeProjectName } from '../utils/PrivacyUtils';
import { ActivityDetector, ActivityEvent } from './ActivityDetector';
import { HeartbeatManager } from './HeartbeatManager';
import { ProductivityScorer } from '../analytics/ProductivityScorer';
import {
    GoalProgress,
    GoalStatus,
    GoalScope,
    GoalWindow,
    calculateGoalProgress,
    getMilestoneCrossings
} from '../analytics/GoalProgress';

function formatGoalEtaAt(timestampMs: number): string {
    const eta = new Date(timestampMs);

    return eta.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
    });
}

export interface CodingSession {
    id: string;
    startTime: Date;
    endTime?: Date;
    duration: number;
    idleDuration: number;
    project: string;
    language: string;
    file: string;
    branch?: string;
    isActive: boolean;
    heartbeats: number;
    keystrokes: number;
    linesAdded: number;
    linesRemoved: number;
    productivityScore?: number;
    tags?: string[];
}

export interface SessionSegment {
    id?: number;
    sessionId: string;
    segmentType: 'active' | 'idle';
    startTime: Date;
    endTime?: Date;
    duration: number;
    project: string;
    language: string;
    file: string;
}

export interface DailyStats {
    date: string;
    totalTime: number;
    activeTime: number;
    idleTime: number;
    sessionCount: number;
    projects: { [key: string]: number };
    languages: { [key: string]: number };
    files: { [key: string]: number };
    productivity: {
        score: number;
        coding: number;
        debugging: number;
        building: number;
    };
}

interface SessionContext {
    project: string;
    language: string;
    file: string;
    branch?: string;
}

interface PersistedFocusSessionState {
    id: string;
    startedAt: number;
    focusTarget: SessionContext;
    focusActiveMs: number;
    distractionCount: number;
    longestContinuousFocusedStreakMs: number;
    currentStreakStart: number | null;
    lastProgressAt: number;
    wasFocused: boolean;
}

export interface FocusSessionReport {
    sessionId: string;
    startedAt: Date;
    endedAt: Date;
    totalFocusSessionMs: number;
    focusActiveMs: number;
    distractionCount: number;
    interruptionRate: number;
    longestContinuousFocusedStreakMs: number;
}

export class TimeTracker {
    private isTracking = false;
    private currentSession: CodingSession | null = null;
    private currentSegment: SessionSegment | null = null;
    private lastSampleAt: Date | null = null;
    private heartbeatManager: HeartbeatManager;
    private activityDetector: ActivityDetector;
    private languageDetector: LanguageDetector;
    private projectDetector: ProjectDetector;
    private analyticsEngine: AnalyticsEngine;
    private productivityScorer: ProductivityScorer;
    private cloudSync: CloudSync | null = null;
    private lastGoalProgressUpdate = 0;
    private cachedGoalProgress: GoalStatus | null = null;
    private readonly goalProgressCacheMs = 15000;
    private goalMilestoneState = new Map<string, Set<number>>();
    private goalMilestoneHighWaterMarks = new Map<string, number>();
    private focusSessionState: PersistedFocusSessionState | null = null;
    private readonly focusSessionStateKey = 'codepulse.focusSessionState';
    private sessionEndedHandler: ((session: CodingSession) => void) | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private databaseManager: DatabaseManager,
        private configManager: ConfigManager,
        private logger: Logger
    ) {
        this.heartbeatManager = new HeartbeatManager(this.configManager, this.logger);
        this.activityDetector = new ActivityDetector(this.configManager, this.logger, async event =>
            this.handleActivityEvent(event)
        );
        this.languageDetector = new LanguageDetector();
        this.projectDetector = new ProjectDetector();
        this.analyticsEngine = new AnalyticsEngine(this.databaseManager, this.configManager);
        this.productivityScorer = new ProductivityScorer(
            this.databaseManager,
            this.configManager.get('heartbeatInterval', 120) * 1000
        );

        if (this.configManager.isCloudSyncEnabled()) {
            this.cloudSync = new CloudSync(this.configManager, this.logger);
        }

        this.focusSessionState = this.restoreFocusSessionState();
        if (this.focusSessionState) {
            this.logger.info(`Restored active focus session ${this.focusSessionState.id} from persisted state`);
        }

        this.setupEventListeners();
    }

    public async start(): Promise<void> {
        if (this.isTracking || !this.configManager.isEnabled()) {
            return;
        }

        try {
            this.isTracking = true;
            this.logger.info('Starting time tracking...');

            this.activityDetector.start();
            await this.startNewSession(vscode.window.activeTextEditor?.document);
            if (this.focusSessionState) {
                const now = new Date();
                const currentContext = await this.getSessionContext(vscode.window.activeTextEditor?.document);
                this.focusSessionState.lastProgressAt = now.getTime();
                this.focusSessionState.wasFocused =
                    !this.activityDetector.isIdle() && this.isFocusTargetMatch(currentContext, this.focusSessionState.focusTarget);
                this.focusSessionState.currentStreakStart = this.focusSessionState.wasFocused ? now.getTime() : null;
                await this.persistFocusSessionState();
            }

            this.lastSampleAt = new Date();
            this.heartbeatManager.start(() => this.sendHeartbeat());
            await this.updateGoalProgressAndMilestones();
        } catch (error) {
            this.isTracking = false;
            this.heartbeatManager.stop();
            this.activityDetector.stop();
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to start time tracking', logError);
            throw error;
        }
    }

    public async stop(): Promise<FocusSessionReport | null> {
        let focusSessionReport: FocusSessionReport | null = null;
        if (!this.isTracking) {
            return focusSessionReport;
        }

        try {
            if (this.focusSessionState) {
                focusSessionReport = await this.stopFocusSession();
            }

            this.isTracking = false;
            this.logger.info('Stopping time tracking...');
            this.heartbeatManager.stop();

            if (this.currentSession) {
                await this.endCurrentSession();
            }

            this.activityDetector.stop();
            await this.updateGoalProgressAndMilestones();

            return focusSessionReport;
        } catch (error) {
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to stop time tracking', logError);
            throw error;
        }
    }

    public async toggleTracking(): Promise<void> {
        try {
            if (this.isTracking) {
                await this.stop();
            } else {
                await this.start();
            }
        } catch (error) {
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to toggle tracking', logError);
            vscode.window.showErrorMessage(`CodePulse: Failed to toggle tracking — ${logError.message}`);
        }
    }

    public isFocusSessionActive(): boolean {
        return this.focusSessionState !== null;
    }

    public async startFocusSession(): Promise<void> {
        if (this.focusSessionState) {
            return;
        }

        if (!this.isTracking || !this.currentSession) {
            throw new Error('Enable time tracking before starting a focus session.');
        }

        const now = new Date();
        const focusTarget = await this.getSessionContext(vscode.window.activeTextEditor?.document);
        const isFocused = !this.activityDetector.isIdle() && this.isFocusTargetMatch(focusTarget, focusTarget);

        this.focusSessionState = {
            id: this.generateSessionId(),
            startedAt: now.getTime(),
            focusTarget,
            focusActiveMs: 0,
            distractionCount: 0,
            longestContinuousFocusedStreakMs: 0,
            currentStreakStart: isFocused ? now.getTime() : null,
            lastProgressAt: now.getTime(),
            wasFocused: isFocused
        };

        this.persistFocusSessionState();
        this.logger.info(`Started focus session ${this.focusSessionState.id} on ${focusTarget.file}`);
    }

    public async stopFocusSession(): Promise<FocusSessionReport | null> {
        if (!this.focusSessionState) {
            return null;
        }

        const now = new Date();
        const context = await this.getSessionContext(vscode.window.activeTextEditor?.document);
        this.updateFocusProgress(now, context);

        const state = this.focusSessionState;
        const currentStreakMs =
            state.currentStreakStart === null ? 0 : now.getTime() - state.currentStreakStart;
        state.longestContinuousFocusedStreakMs = Math.max(state.longestContinuousFocusedStreakMs, currentStreakMs);

        const totalFocusSessionMs = Math.max(0, now.getTime() - state.startedAt);
        const interruptionRate = totalFocusSessionMs > 0 ? state.distractionCount / (totalFocusSessionMs / 60000) : 0;

        const report: FocusSessionReport = {
            sessionId: state.id,
            startedAt: new Date(state.startedAt),
            endedAt: now,
            totalFocusSessionMs,
            focusActiveMs: state.focusActiveMs,
            distractionCount: state.distractionCount,
            interruptionRate: Number(interruptionRate.toFixed(2)),
            longestContinuousFocusedStreakMs: state.longestContinuousFocusedStreakMs
        };

        this.focusSessionState = null;
        this.clearFocusSessionState();

        return report;
    }

    public async toggleFocusSession(): Promise<FocusSessionReport | null> {
        if (this.isFocusSessionActive()) {
            return await this.stopFocusSession();
        }

        await this.startFocusSession();
        return null;
    }

    public async refreshConfiguration(): Promise<void> {
        this.configManager.reloadConfiguration();
        this.heartbeatManager.updateConfiguration();
        this.activityDetector.updateConfiguration();
        this.resetGoalProgressState();

        if (this.configManager.isCloudSyncEnabled()) {
            if (!this.cloudSync) {
                this.cloudSync = new CloudSync(this.configManager, this.logger);
            } else {
                this.cloudSync.updateConfiguration();
            }
        } else if (this.cloudSync) {
            this.cloudSync.stop();
            this.cloudSync = null;
        }

        if (!this.configManager.isEnabled() && this.isTracking) {
            await this.stop();
        } else if (this.configManager.isEnabled() && !this.isTracking) {
            await this.start();
        }
    }

    public async showTodaysStats(): Promise<void> {
        try {
            const stats = await this.getTodaysStats();
            const message = this.formatStatsMessage(stats);
            await vscode.window.showInformationMessage(message, { modal: true });
        } catch (error) {
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.error("Failed to show today's stats", logError);
            vscode.window.showErrorMessage("Failed to load today's statistics.");
        }
    }

    public async exportData(): Promise<void> {
        try {
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`codepulse-export-${formatLocalDate(new Date())}.json`),
                filters: {
                    JSON: ['json']
                }
            });

            if (!uri) {
                return;
            }

            const data = await this.databaseManager.exportAllData();
            const content = JSON.stringify(data, null, 2);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content));

            if (this.configManager.shouldShowNotifications()) {
                void vscode.window.showInformationMessage(`Data exported to ${uri.fsPath}`);
            }
        } catch (error) {
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to export data', logError);
            vscode.window.showErrorMessage('Failed to export data.');
        }
    }

    public getCurrentSession(): CodingSession | null {
        if (!this.currentSession) {
            return null;
        }

        return {
            ...this.currentSession,
            duration: this.getLiveSessionDuration(),
            idleDuration: this.getLiveIdleDuration()
        };
    }

    /**
     * Registers a callback that receives the final session snapshot when a
     * tracked session ends (e.g. so DaemonClient can emit session.ended).
     */
    public setSessionEndedHandler(handler: ((session: CodingSession) => void) | undefined): void {
        this.sessionEndedHandler = handler;
    }

    public isEnabled(): boolean {
        return this.configManager.isEnabled();
    }

    public isIdle(): boolean {
        return this.activityDetector.isIdle();
    }

    public getLiveSessionDuration(): number {
        if (!this.currentSession) {
            return 0;
        }

        return this.currentSession.duration + this.getPendingElapsed().active;
    }

    public getLiveIdleDuration(): number {
        if (!this.currentSession) {
            return 0;
        }

        return this.currentSession.idleDuration + this.getPendingElapsed().idle;
    }

    public async getTodaysStats(): Promise<DailyStats> {
        return this.analyticsEngine.getDailyStats(formatLocalDate(new Date()));
    }

    public async getWeeklyStats(): Promise<DailyStats[]> {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - 6);
        return this.analyticsEngine.getWeeklyStats(startDate, endDate);
    }

    public async getGoalProgress(): Promise<GoalStatus> {
        return this.computeGoalProgress({
            forceRefresh: false
        });
    }

    public resetGoalProgressState(): void {
        this.goalMilestoneState = new Map<string, Set<number>>();
        this.goalMilestoneHighWaterMarks = new Map<string, number>();
        this.clearGoalProgressCache();
    }

    private async computeGoalProgress({
        forceRefresh,
        currentProject
    }: {
        forceRefresh?: boolean;
        currentProject?: string | null;
    }): Promise<GoalStatus> {
        const now = new Date();
        const nowMs = now.getTime();

        if (!this.configManager.isGoalTrackingEnabled()) {
            const empty = this.createEmptyGoalStatus();
            this.cachedGoalProgress = empty;
            this.lastGoalProgressUpdate = nowMs;
            return empty;
        }

        if (!forceRefresh && this.cachedGoalProgress && nowMs - this.lastGoalProgressUpdate < this.goalProgressCacheMs) {
            return this.cachedGoalProgress;
        }

        const todayStats = await this.getTodaysStats();
        const weeklyStats = await this.getWeeklyStats();
        const projectName = (currentProject || this.currentSession?.project || '').trim() || null;
        const liveActiveMs = this.currentSession ? this.getPendingElapsed().active : 0;
        const dailyWindowStart = startOfLocalDay(now);
        const weeklyWindowStart = this.getWeeklyWindowStart(now);

        const globalGoalMinutes = this.configManager.getGlobalDailyGoalMinutes();
        const globalWindowMinutes = this.configManager.getGlobalWeeklyGoalMinutes();

        const global = {
            daily: calculateGoalProgress({
                scope: 'global',
                window: 'daily',
                goalMinutes: globalGoalMinutes,
                currentMs: todayStats.totalTime + liveActiveMs,
                windowStart: dailyWindowStart,
                now
            }),
            weekly: calculateGoalProgress({
                scope: 'global',
                window: 'weekly',
                goalMinutes: globalWindowMinutes,
                currentMs: this.getWindowTotalMs(weeklyStats, 'totalTime') + liveActiveMs,
                windowStart: weeklyWindowStart,
                now
            })
        };

        const hasProjectGoalConfigured = this.configManager.isProjectGoalConfigured(projectName);
        const projectGoal = projectName ? this.configManager.getProjectGoal(projectName) : {};
        const projectDailyMinutes = hasProjectGoalConfigured && projectName
            ? this.normalizeGoalValue(projectGoal.dailyMinutes)
            : 0;
        const projectWeeklyMinutes = hasProjectGoalConfigured && projectName
            ? this.normalizeGoalValue(projectGoal.weeklyMinutes)
            : 0;
        const projectWindowMs = this.getProjectWindowMinutes(projectName, todayStats, weeklyStats, liveActiveMs);

        const next: GoalStatus = {
            global,
            project: {
                projectName,
                daily: calculateGoalProgress({
                    scope: 'project',
                    window: 'daily',
                    goalMinutes: projectDailyMinutes,
                    currentMs: projectWindowMs.daily,
                    windowStart: dailyWindowStart,
                    now
                }),
                weekly: calculateGoalProgress({
                    scope: 'project',
                    window: 'weekly',
                    goalMinutes: projectWeeklyMinutes,
                    currentMs: projectWindowMs.weekly,
                    windowStart: weeklyWindowStart,
                    now
                })
            },
            now: nowMs
        };

        this.cachedGoalProgress = next;
        this.lastGoalProgressUpdate = nowMs;

        return next;
    }

    private async updateGoalProgressAndMilestones(currentProject?: string | null): Promise<void> {
        try {
            const previousGoalProgress = this.cachedGoalProgress;
            const goalProgress = await this.computeGoalProgress({
                forceRefresh: true,
                currentProject
            });
            await this.notifyGoalMilestones(goalProgress, previousGoalProgress);
        } catch (error) {
            this.logger.warn('Failed to update goal progress', error instanceof Error ? error : new Error(String(error)));
        }
    }

    private async notifyGoalMilestones(
        goalProgress: GoalStatus,
        previousGoalProgress: GoalStatus | null
    ): Promise<void> {
        if (!this.configManager.shouldNotifyWhenOnTrack()) {
            return;
        }

        const projectName = goalProgress.project.projectName;
        const hasAnyGoal =
            goalProgress.global.daily.isGoalSet ||
            goalProgress.global.weekly.isGoalSet ||
            (projectName && this.configManager.isProjectGoalConfigured(projectName));

        if (!hasAnyGoal) {
            return;
        }

        if (!this.currentSession && !projectName) {
            return;
        }

        const previousProjectGoal =
            previousGoalProgress?.project.projectName === projectName ? previousGoalProgress.project : null;

        await this.notifyMilestonesForGoal(
            'Global Daily',
            goalProgress.global.daily,
            previousGoalProgress?.global.daily || null,
            `global:daily`
        );

        await this.notifyMilestonesForGoal(
            'Global Weekly',
            goalProgress.global.weekly,
            previousGoalProgress?.global.weekly || null,
            `global:weekly`
        );

        const shouldTrackProjectGoals = projectName && this.configManager.isProjectGoalConfigured(projectName);

        if (shouldTrackProjectGoals) {
            await this.notifyMilestonesForGoal(
                `Project ${projectName} Daily`,
                goalProgress.project.daily,
                previousProjectGoal?.daily || null,
                `project:${projectName}:daily`
            );

            await this.notifyMilestonesForGoal(
                `Project ${projectName} Weekly`,
                goalProgress.project.weekly,
                previousProjectGoal?.weekly || null,
                `project:${projectName}:weekly`
            );
        }
    }

    private async notifyMilestonesForGoal(
        scopeLabel: string,
        current: GoalProgress,
        previous: GoalProgress | null,
        stateKey: string
    ): Promise<void> {
        if (!current.isGoalSet) {
            this.deleteMilestoneSets(stateKey);
            this.goalMilestoneHighWaterMarks.delete(stateKey);
            return;
        }

        if (current.window === 'weekly') {
            this.notifyWeeklyMilestones(scopeLabel, current, previous, stateKey);
            return;
        }

        // Key reached-sets by window identity so a daily rollover starts a fresh set.
        const windowKey = `${stateKey}:${this.getGoalWindowKey(current.window, new Date())}`;
        const reached = this.getOrCreateMilestoneSet(stateKey, windowKey);

        if (!previous?.isGoalSet) {
            // First computation after activation/reset: baseline already-passed milestones without toasts.
            for (const milestone of getMilestoneCrossings(0, current.percent)) {
                reached.add(milestone);
            }
            return;
        }

        const currentMilestones = getMilestoneCrossings(previous.percent, current.percent);

        for (const milestone of currentMilestones) {
            if (!reached.has(milestone)) {
                reached.add(milestone);
                this.showGoalMilestoneToast(scopeLabel, current, milestone);
            }
        }
    }

    /**
     * Weekly goals use a ROLLING 7-day window: the percent legitimately dips at every
     * midnight (the oldest day falls out) and climbs back, so window-keyed reached-sets
     * would re-toast the same milestone on consecutive days. Instead, keep the highest
     * percent already notified per goal and only toast milestones strictly above that
     * high-water mark. The mark resets only when goal configuration changes
     * (resetGoalProgressState) or the goal becomes unset.
     */
    private notifyWeeklyMilestones(
        scopeLabel: string,
        current: GoalProgress,
        previous: GoalProgress | null,
        stateKey: string
    ): void {
        const previousMark = this.goalMilestoneHighWaterMarks.get(stateKey);

        if (!previous?.isGoalSet || previousMark === undefined) {
            // First computation after activation/reset: baseline silently at the current percent.
            this.goalMilestoneHighWaterMarks.set(stateKey, current.percent);
            return;
        }

        if (current.percent <= previousMark) {
            return;
        }

        for (const milestone of getMilestoneCrossings(previousMark, current.percent)) {
            this.showGoalMilestoneToast(scopeLabel, current, milestone);
        }

        this.goalMilestoneHighWaterMarks.set(stateKey, current.percent);
    }

    private showGoalMilestoneToast(scopeLabel: string, current: GoalProgress, milestone: number): void {
        const remainingText = this.formatDurationMinutes(current.remainingMinutes);
        const etaText = current.etaAt ? ` ETA ${formatGoalEtaAt(current.etaAt)}` : ' ETA unavailable';
        const progressPercent = Math.round(current.percent);
        const isComplete = milestone >= 100;
        const message = isComplete && current.isGoalMet
            ? `${scopeLabel} goal completed (${progressPercent}%).`
            : `${scopeLabel} goal reached ${milestone}% (${remainingText} remaining).${etaText}`;

        void vscode.window.showInformationMessage(`Code Pulse goals: ${message}`);
    }

    private getGoalWindowKey(window: GoalWindow, now: Date): string {
        const windowStart = window === 'weekly' ? this.getWeeklyWindowStart(now) : startOfLocalDay(now);
        return formatLocalDate(windowStart);
    }

    private getOrCreateMilestoneSet(stateKey: string, windowKey: string): Set<number> {
        let set = this.goalMilestoneState.get(windowKey);
        if (!set) {
            // New window (or first run) — drop stale sets from previous windows of this goal.
            this.deleteMilestoneSets(stateKey);
            set = new Set<number>();
            this.goalMilestoneState.set(windowKey, set);
        }

        return set;
    }

    private deleteMilestoneSets(stateKey: string): void {
        const prefix = `${stateKey}:`;
        for (const key of Array.from(this.goalMilestoneState.keys())) {
            if (key.startsWith(prefix)) {
                this.goalMilestoneState.delete(key);
            }
        }
    }

    private clearGoalProgressCache(): void {
        this.cachedGoalProgress = null;
        this.lastGoalProgressUpdate = 0;
    }

    private getWeeklyWindowStart(now: Date): Date {
        const start = startOfLocalDay(now);
        start.setDate(start.getDate() - 6);
        return start;
    }

    private getWindowTotalMs(stats: DailyStats[], key: 'totalTime' | 'activeTime' | 'idleTime'): number {
        return stats.reduce((total, day) => total + Math.max(0, day[key] || 0), 0);
    }

    private getProjectWindowMinutes(
        projectName: string | null,
        todayStats: DailyStats,
        weeklyStats: DailyStats[],
        liveActiveMs: number
    ): { daily: number; weekly: number } {
        if (!projectName) {
            return this.getEmptyProjectWindow();
        }

        const daily = Math.max(0, (todayStats.projects[projectName] || 0));
        const weekly = Math.max(
            0,
            weeklyStats.reduce((total, day) => total + Math.max(0, day.projects?.[projectName] || 0), 0)
        );

        const includeLive =
            this.currentSession && this.currentSession.project === projectName ? Math.max(0, liveActiveMs) : 0;

        return {
            daily: daily + includeLive,
            weekly: weekly + includeLive
        };
    }

    private getEmptyProjectWindow(): { daily: number; weekly: number } {
        return {
            daily: 0,
            weekly: 0
        };
    }

    private normalizeGoalValue(value: unknown): number {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            return 0;
        }

        return Math.floor(value);
    }

    private createEmptyGoalStatus(): GoalStatus {
        const emptyGoal = (scope: GoalScope, window: GoalWindow): GoalProgress => ({
            scope,
            window,
            goalMinutes: 0,
            currentMinutes: 0,
            percent: 0,
            remainingMinutes: 0,
            isGoalSet: false,
            isGoalMet: false,
            etaAt: null
        });

        return {
            global: {
                daily: emptyGoal('global', 'daily'),
                weekly: emptyGoal('global', 'weekly')
            },
            project: {
                projectName: null,
                daily: emptyGoal('project', 'daily'),
                weekly: emptyGoal('project', 'weekly')
            },
            now: Date.now()
        };
    }

    private formatDurationMinutes(minutes: number): string {
        const totalMinutes = Math.max(0, Math.round(minutes));
        const hours = Math.floor(totalMinutes / 60);
        const remainingMinutes = totalMinutes % 60;

        if (hours > 0) {
            return `${hours}h ${remainingMinutes}m`;
        }

        return `${remainingMinutes}m`;
    }

    private formatDurationMs(durationMs: number): string {
        const totalMinutes = Math.max(0, Math.round(durationMs / 60000));
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        }

        return `${minutes}m`;
    }

    private restoreFocusSessionState(): PersistedFocusSessionState | null {
        const value = this.context.globalState.get<unknown>(this.focusSessionStateKey);
        if (!value || typeof value !== 'object') {
            return null;
        }

        const candidate = value as Record<string, unknown>;
        if (
            typeof candidate.id !== 'string' ||
            typeof candidate.startedAt !== 'number' ||
            typeof candidate.focusActiveMs !== 'number' ||
            typeof candidate.distractionCount !== 'number' ||
            typeof candidate.longestContinuousFocusedStreakMs !== 'number' ||
            typeof candidate.lastProgressAt !== 'number' ||
            typeof candidate.wasFocused !== 'boolean'
        ) {
            return null;
        }

        const focusTarget = candidate.focusTarget;
        if (!focusTarget || typeof focusTarget !== 'object') {
            return null;
        }

        const target = focusTarget as Record<string, unknown>;
        if (
            typeof target.project !== 'string' ||
            typeof target.language !== 'string' ||
            typeof target.file !== 'string'
        ) {
            return null;
        }

        const branch = typeof target.branch === 'string' ? target.branch : undefined;
        const currentStreakStart =
            typeof candidate.currentStreakStart === 'number' ? candidate.currentStreakStart : null;

        return {
            id: candidate.id,
            startedAt: candidate.startedAt,
            focusTarget: {
                project: target.project,
                language: target.language,
                file: target.file,
                branch
            },
            focusActiveMs: Math.max(0, Math.floor(candidate.focusActiveMs)),
            distractionCount: Math.max(0, Math.floor(candidate.distractionCount)),
            longestContinuousFocusedStreakMs: Math.max(
                0,
                Math.floor(candidate.longestContinuousFocusedStreakMs)
            ),
            currentStreakStart,
            lastProgressAt: candidate.lastProgressAt,
            wasFocused: candidate.wasFocused
        };
    }

    private persistFocusSessionState(): void {
        if (!this.focusSessionState) {
            return;
        }

        void this.context.globalState.update(this.focusSessionStateKey, this.focusSessionState);
    }

    private clearFocusSessionState(): void {
        void this.context.globalState.update(this.focusSessionStateKey, undefined);
    }

    private updateFocusProgress(now: Date, currentContext: SessionContext): void {
        const state = this.focusSessionState;
        if (!state) {
            return;
        }

        const elapsedMs = Math.max(0, now.getTime() - state.lastProgressAt);
        const nowFocused =
            !this.activityDetector.isIdle() && this.isFocusTargetMatch(currentContext, state.focusTarget);

        if (state.wasFocused && nowFocused) {
            state.focusActiveMs = Math.max(0, state.focusActiveMs + elapsedMs);
        }

        if (state.wasFocused && !nowFocused) {
            if (state.currentStreakStart !== null) {
                const currentStreakMs = now.getTime() - state.currentStreakStart;
                state.longestContinuousFocusedStreakMs = Math.max(
                    state.longestContinuousFocusedStreakMs,
                    currentStreakMs
                );
            }
            state.currentStreakStart = null;
            state.distractionCount += 1;
        }

        if (!state.wasFocused && nowFocused) {
            state.currentStreakStart = now.getTime();
        }

        state.lastProgressAt = now.getTime();
        state.wasFocused = nowFocused;
        this.persistFocusSessionState();
    }

    private isFocusTargetMatch(a: SessionContext, b: SessionContext): boolean {
        return (
            a.project === b.project &&
            a.language === b.language &&
            a.file === b.file &&
            (a.branch || '') === (b.branch || '')
        );
    }

    private async startNewSession(document?: vscode.TextDocument): Promise<void> {
        const context = await this.getSessionContext(document);
        const startTime = new Date();

        this.currentSession = {
            id: this.generateSessionId(),
            startTime,
            duration: 0,
            idleDuration: 0,
            project: context.project,
            language: context.language,
            file: context.file,
            branch: context.branch,
            tags: [],
            isActive: true,
            heartbeats: 0,
            keystrokes: 0,
            linesAdded: 0,
            linesRemoved: 0
        };

        this.currentSegment = null;
        this.lastSampleAt = startTime;

        await this.databaseManager.saveSession(this.currentSession);
        await this.ensureSegment(this.activityDetector.isIdle() ? 'idle' : 'active', context, startTime);
        this.logger.info(`Started new session: ${this.currentSession.id}`);
        await this.updateGoalProgressAndMilestones();
    }

    public async addTagsToCurrentSession(rawTags: string[]): Promise<string[]> {
        if (!this.currentSession) {
            throw new Error('No active session to tag');
        }

        const normalized = this.normalizeTags(rawTags);
        const existing = new Set(this.currentSession.tags ? this.normalizeTags(this.currentSession.tags) : []);
        normalized.forEach(tag => existing.add(tag));

        this.currentSession.tags = Array.from(existing);
        await this.databaseManager.updateSession(this.currentSession);

        return [...this.currentSession.tags];
    }

    public async clearCurrentSessionTags(): Promise<string[]> {
        if (!this.currentSession) {
            throw new Error('No active session to update');
        }

        this.currentSession.tags = [];
        await this.databaseManager.updateSession(this.currentSession);
        return [];
    }

    private normalizeTags(rawTags: string[]): string[] {
        const tags = rawTags
            .flatMap(tag => String(tag).split(','))
            .map(tag => tag.trim().toLowerCase())
            .filter(tag => tag.length > 0);

        return Array.from(new Set(tags));
    }

    private async endCurrentSession(): Promise<void> {
        if (!this.currentSession) {
            return;
        }
        const endedProject = this.currentSession.project;

        const endTime = new Date();
        await this.applyElapsed(endTime, false);

        this.currentSession.endTime = endTime;
        this.currentSession.isActive = false;

        // Save session and finalize segment immediately — don't block on scoring
        await Promise.all([this.databaseManager.updateSession(this.currentSession), this.finalizeSegment(endTime)]);

        if (formatLocalDate(this.currentSession.startTime) === formatLocalDate(endTime)) {
            await this.databaseManager.incrementDailyRollup(
                formatLocalDate(this.currentSession.startTime),
                this.currentSession
            );
        }

        // Run productivity scoring and cloud sync in background (non-blocking)
        const session = { ...this.currentSession };

        // Hand the final session snapshot to listeners (daemon forwarding) BEFORE nulling currentSession
        if (this.sessionEndedHandler) {
            try {
                this.sessionEndedHandler(session);
            } catch (error) {
                this.logger.warn(
                    'Session-ended handler failed',
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        }

        if (this.configManager.get('analytics.enableProductivityScore', true)) {
            this.productivityScorer
                .calculateSessionScore(session)
                .then(score => {
                    session.productivityScore = score;
                    this.databaseManager.updateSession(session).catch(err => {
                        this.logger.warn(
                            'Failed to save productivity score',
                            err instanceof Error ? err : new Error(String(err))
                        );
                    });
                })
                .catch(err => {
                    this.logger.warn(
                        'Failed to calculate productivity score',
                        err instanceof Error ? err : new Error(String(err))
                    );
                });
        }

        if (this.cloudSync) {
            this.cloudSync.syncSession(session).catch(err => {
                this.logger.warn(
                    'Failed to sync session to cloud',
                    err instanceof Error ? err : new Error(String(err))
                );
            });
        }

        this.logger.info(
            `Ended session: ${this.currentSession.id}, Active: ${this.currentSession.duration}ms, Idle: ${this.currentSession.idleDuration}ms`
        );

        this.currentSession = null;
        this.currentSegment = null;
        this.lastSampleAt = null;
        await this.updateGoalProgressAndMilestones(endedProject);
    }

    private async sendHeartbeat(): Promise<void> {
        if (!this.currentSession) {
            return;
        }

        const now = new Date();
        const activeDocument = vscode.window.activeTextEditor?.document;
        const currentContext = await this.getSessionContext(activeDocument);
        const shouldTrackProjectSwitching = this.configManager.get('trackProjectSwitching', true);
        const shouldTrackFileChanges = this.configManager.get('trackFileChanges', true);

        if (this.focusSessionState) {
            this.updateFocusProgress(now, currentContext);
        }

        const projectChanged = shouldTrackProjectSwitching && currentContext.project !== this.currentSession.project;
        const languageChanged = shouldTrackFileChanges && currentContext.language !== this.currentSession.language;

        if (projectChanged || languageChanged) {
            await this.applyElapsed(now, false);
            await this.endCurrentSession();
            await this.startNewSession(activeDocument);
            await this.updateGoalProgressAndMilestones();
            return;
        }

        await this.applyElapsed(now, true);
        await this.databaseManager.updateSession(this.currentSession);
        await this.updateGoalProgressAndMilestones();
    }

    private setupEventListeners(): void {
        this.context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(async editor => {
                if (this.isTracking && editor) {
                    await this.handleFileChange(editor);
                }
            })
        );

        this.context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                if (this.isTracking && this.currentSession) {
                    void this.handleTextChange(event);
                }
            })
        );

        this.context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(async () => {
                if (this.isTracking && this.configManager.get('trackProjectSwitching', true)) {
                    await this.handleWorkspaceChange();
                }
            })
        );

        // Configuration changes are handled by extension.ts via synchronizeRuntimeConfiguration()
    }

    private async handleFileChange(editor: vscode.TextEditor): Promise<void> {
        if (!this.currentSession) {
            return;
        }

        const now = new Date();
        const nextContext = await this.getSessionContext(editor.document);
        const shouldTrackProjectSwitching = this.configManager.get('trackProjectSwitching', true);
        const shouldTrackFileChanges = this.configManager.get('trackFileChanges', true);

        const projectChanged = shouldTrackProjectSwitching && nextContext.project !== this.currentSession.project;
        const languageChanged = shouldTrackFileChanges && nextContext.language !== this.currentSession.language;
        const fileChanged = shouldTrackFileChanges && nextContext.file !== this.currentSession.file;
        if (this.focusSessionState) {
            this.updateFocusProgress(now, nextContext);
        }

        await this.applyElapsed(now, false);

        if (projectChanged || languageChanged) {
            await this.endCurrentSession();
            await this.startNewSession(editor.document);
            return;
        }

        if (fileChanged) {
            this.currentSession.file = nextContext.file;
            await this.ensureSegment(this.activityDetector.isIdle() ? 'idle' : 'active', nextContext, now);
            await this.databaseManager.updateSession(this.currentSession);
        }
    }

    private async handleTextChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
        if (!this.currentSession) {
            return;
        }

        if (this.focusSessionState) {
            const editContext = await this.getSessionContext(event.document);
            this.updateFocusProgress(new Date(), editContext);
        }

        // The session may have ended while awaiting the context above.
        if (!this.currentSession) {
            return;
        }

        event.contentChanges.forEach(change => {
            this.currentSession!.keystrokes += change.text.length;

            const linesAdded = (change.text.match(/\n/g) || []).length;
            const linesRemoved =
                change.rangeLength > 0 ? Math.max(0, change.range.end.line - change.range.start.line) : 0;

            this.currentSession!.linesAdded += linesAdded;
            this.currentSession!.linesRemoved += linesRemoved;
        });
    }

    private async handleWorkspaceChange(): Promise<void> {
        if (!this.currentSession) {
            return;
        }

        const now = new Date();
        if (this.focusSessionState) {
            const workspaceContext = await this.getSessionContext(vscode.window.activeTextEditor?.document);
            this.updateFocusProgress(now, workspaceContext);
        }

        await this.applyElapsed(now, false);
        await this.endCurrentSession();
        await this.startNewSession(vscode.window.activeTextEditor?.document);
    }

    private async handleActivityEvent(event: ActivityEvent): Promise<void> {
        const project =
            this.currentSession?.project ||
            (await this.getSessionContext(vscode.window.activeTextEditor?.document)).project;
        const sanitizedEvent: ActivityEvent = {
            ...event,
            sessionId: this.currentSession?.id,
            file: event.file
                ? sanitizeFilePath(
                      event.file,
                      this.configManager.shouldTrackFilenames(),
                      this.configManager.shouldAnonymizeData()
                  )
                : undefined,
            project: sanitizeProjectName(project, this.configManager.shouldAnonymizeData()),
            isIdle: this.activityDetector.isIdle()
        };

        await this.databaseManager.saveActivityEvent(sanitizedEvent);

        if (this.cloudSync) {
            await this.cloudSync.syncActivity(sanitizedEvent);
        }
    }

    private async applyElapsed(now: Date, countHeartbeat: boolean): Promise<void> {
        if (!this.currentSession) {
            return;
        }

        if (!this.lastSampleAt) {
            this.lastSampleAt = now;
            return;
        }

        const context = await this.getSessionContext(vscode.window.activeTextEditor?.document);

        // The session may have ended while awaiting the context above.
        if (!this.currentSession || !this.lastSampleAt) {
            return;
        }

        const elapsed = Math.max(0, now.getTime() - this.lastSampleAt.getTime());

        if (elapsed === 0) {
            await this.ensureSegment(this.activityDetector.isIdle() ? 'idle' : 'active', context, now);
            return;
        }

        const segmentType = this.activityDetector.isIdle() ? 'idle' : 'active';
        await this.ensureSegment(segmentType, context, now);

        if (this.currentSegment) {
            this.currentSegment.duration += elapsed;
            this.currentSegment.endTime = now;
            await this.databaseManager.updateSessionSegment(this.currentSegment);
        }

        if (segmentType === 'idle') {
            this.currentSession.idleDuration += elapsed;
        } else {
            this.currentSession.duration += elapsed;
            if (countHeartbeat) {
                this.currentSession.heartbeats++;
            }
        }

        this.lastSampleAt = now;
    }

    private async ensureSegment(
        segmentType: SessionSegment['segmentType'],
        context: SessionContext,
        now: Date
    ): Promise<void> {
        const shouldRotateSegment =
            !this.currentSegment ||
            this.currentSegment.segmentType !== segmentType ||
            this.currentSegment.project !== context.project ||
            this.currentSegment.language !== context.language ||
            this.currentSegment.file !== context.file;

        if (!shouldRotateSegment) {
            return;
        }

        await this.finalizeSegment(now);

        if (!this.currentSession) {
            return;
        }

        const nextSegment: SessionSegment = {
            sessionId: this.currentSession.id,
            segmentType,
            startTime: now,
            endTime: now,
            duration: 0,
            project: context.project,
            language: context.language,
            file: context.file
        };

        nextSegment.id = await this.databaseManager.saveSessionSegment(nextSegment);
        this.currentSegment = nextSegment;
    }

    private async finalizeSegment(now: Date): Promise<void> {
        if (!this.currentSegment) {
            return;
        }

        this.currentSegment.endTime = now;
        await this.databaseManager.updateSessionSegment(this.currentSegment);
        this.currentSegment = null;
    }

    private async getSessionContext(document?: vscode.TextDocument): Promise<SessionContext> {
        const anonymizeData = this.configManager.shouldAnonymizeData();
        const trackFilenames = this.configManager.shouldTrackFilenames();
        const projectName = this.projectDetector.getCurrentProject(document);
        const fileName = document?.fileName || 'untitled';
        const language = document ? this.languageDetector.detectLanguage(document) : 'unknown';
        const branch = await this.projectDetector.getCurrentBranch(document);

        return {
            project: sanitizeProjectName(projectName, anonymizeData),
            language,
            file: sanitizeFilePath(fileName, trackFilenames, anonymizeData),
            branch
        };
    }

    private getPendingElapsed(): { active: number; idle: number } {
        if (!this.currentSession || !this.lastSampleAt) {
            return { active: 0, idle: 0 };
        }

        const elapsed = Math.max(0, Date.now() - this.lastSampleAt.getTime());
        if (elapsed === 0) {
            return { active: 0, idle: 0 };
        }

        return this.activityDetector.isIdle() ? { active: 0, idle: elapsed } : { active: elapsed, idle: 0 };
    }

    private formatStatsMessage(stats: DailyStats): string {
        const totalHours = Math.floor(stats.totalTime / (1000 * 60 * 60));
        const totalMinutes = Math.floor((stats.totalTime % (1000 * 60 * 60)) / (1000 * 60));
        const topProject = this.getTopKey(stats.projects, 'n/a');
        const topLanguage = this.getTopKey(stats.languages, 'n/a');

        return `Today's Coding Stats:
⏱️ Active Time: ${totalHours}h ${totalMinutes}m
🛌 Idle Time: ${Math.round(stats.idleTime / (1000 * 60))}m
🧩 Sessions: ${stats.sessionCount}
📁 Top Project: ${topProject}
🔤 Top Language: ${topLanguage}
📈 Productivity Score: ${Math.round(stats.productivity.score)}%`;
    }

    private getTopKey(values: { [key: string]: number }, fallback: string): string {
        const entries = Object.entries(values);
        if (entries.length === 0) {
            return fallback;
        }

        return entries.reduce((topEntry, currentEntry) => (currentEntry[1] > topEntry[1] ? currentEntry : topEntry))[0];
    }

    private generateSessionId(): string {
        return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }
}
