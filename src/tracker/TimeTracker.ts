import * as vscode from 'vscode';
import { AnalyticsEngine } from '../analytics/AnalyticsEngine';
import { LanguageDetector } from '../detectors/LanguageDetector';
import { ProjectDetector } from '../detectors/ProjectDetector';
import { CloudSync } from '../storage/CloudSync';
import { DatabaseManager } from '../storage/DatabaseManager';
import { ConfigManager } from '../utils/ConfigManager';
import { formatLocalDate } from '../utils/DateUtils';
import { Logger } from '../utils/Logger';
import { sanitizeFilePath, sanitizeProjectName } from '../utils/PrivacyUtils';
import { ActivityDetector, ActivityEvent } from './ActivityDetector';
import { HeartbeatManager } from './HeartbeatManager';
import { ProductivityScorer } from '../analytics/ProductivityScorer';

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
        this.productivityScorer = new ProductivityScorer(this.databaseManager);

        if (this.configManager.isCloudSyncEnabled()) {
            this.cloudSync = new CloudSync(this.configManager, this.logger);
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
            this.lastSampleAt = new Date();
            this.heartbeatManager.start(() => this.sendHeartbeat());
        } catch (error) {
            this.isTracking = false;
            this.heartbeatManager.stop();
            this.activityDetector.stop();
            const logError = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to start time tracking', logError);
            throw error;
        }
    }

    public async stop(): Promise<void> {
        if (!this.isTracking) {
            return;
        }

        try {
            this.isTracking = false;
            this.logger.info('Stopping time tracking...');
            this.heartbeatManager.stop();

            if (this.currentSession) {
                await this.endCurrentSession();
            }

            this.activityDetector.stop();
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

    public async refreshConfiguration(): Promise<void> {
        this.configManager.reloadConfiguration();
        this.heartbeatManager.updateConfiguration();
        this.activityDetector.updateConfiguration();

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

    private async startNewSession(document?: vscode.TextDocument): Promise<void> {
        const context = this.getSessionContext(document);
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
    }

    private async endCurrentSession(): Promise<void> {
        if (!this.currentSession) {
            return;
        }

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
    }

    private async sendHeartbeat(): Promise<void> {
        if (!this.currentSession) {
            return;
        }

        const now = new Date();
        const activeDocument = vscode.window.activeTextEditor?.document;
        const currentContext = this.getSessionContext(activeDocument);
        const shouldTrackProjectSwitching = this.configManager.get('trackProjectSwitching', true);
        const shouldTrackFileChanges = this.configManager.get('trackFileChanges', true);

        const projectChanged = shouldTrackProjectSwitching && currentContext.project !== this.currentSession.project;
        const languageChanged = shouldTrackFileChanges && currentContext.language !== this.currentSession.language;

        if (projectChanged || languageChanged) {
            await this.applyElapsed(now, false);
            await this.endCurrentSession();
            await this.startNewSession(activeDocument);
            return;
        }

        await this.applyElapsed(now, true);
        await this.databaseManager.updateSession(this.currentSession);
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
                    this.handleTextChange(event);
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
        const nextContext = this.getSessionContext(editor.document);
        const shouldTrackProjectSwitching = this.configManager.get('trackProjectSwitching', true);
        const shouldTrackFileChanges = this.configManager.get('trackFileChanges', true);

        const projectChanged = shouldTrackProjectSwitching && nextContext.project !== this.currentSession.project;
        const languageChanged = shouldTrackFileChanges && nextContext.language !== this.currentSession.language;
        const fileChanged = shouldTrackFileChanges && nextContext.file !== this.currentSession.file;

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

    private handleTextChange(event: vscode.TextDocumentChangeEvent): void {
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

        await this.applyElapsed(new Date(), false);
        await this.endCurrentSession();
        await this.startNewSession(vscode.window.activeTextEditor?.document);
    }

    private async handleActivityEvent(event: ActivityEvent): Promise<void> {
        const project =
            this.currentSession?.project || this.getSessionContext(vscode.window.activeTextEditor?.document).project;
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

        const elapsed = Math.max(0, now.getTime() - this.lastSampleAt.getTime());
        const context = this.getSessionContext(vscode.window.activeTextEditor?.document);

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

    private getSessionContext(document?: vscode.TextDocument): SessionContext {
        const anonymizeData = this.configManager.shouldAnonymizeData();
        const trackFilenames = this.configManager.shouldTrackFilenames();
        const projectName = this.projectDetector.getCurrentProject(document);
        const fileName = document?.fileName || 'untitled';
        const language = document ? this.languageDetector.detectLanguage(document) : 'unknown';
        const branch = this.projectDetector.getCurrentBranch(document);

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
