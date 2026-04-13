import * as vscode from 'vscode';
import { ConfigManager } from '../utils/ConfigManager';
import { Logger } from '../utils/Logger';

export interface ActivityEvent {
    type: 'file_open' | 'file_close' | 'file_edit' | 'file_save' | 'selection_change' | 'cursor_move' | 'focus_change';
    timestamp: Date;
    sessionId?: string;
    file?: string;
    language?: string;
    project?: string;
    isIdle?: boolean;
    metadata?: { [key: string]: any };
}

export class ActivityDetector {
    private isRunning = false;
    private idleThresholdMs: number;
    private lastActivityTime: number = Date.now();
    private idleCheckTimer: NodeJS.Timeout | null = null;
    private activityEvents: ActivityEvent[] = [];
    private eventListeners: vscode.Disposable[] = [];
    private currentIdleState = false;

    constructor(
        private configManager: ConfigManager,
        private logger: Logger,
        private onActivity?: (event: ActivityEvent) => Promise<void> | void
    ) {
        this.idleThresholdMs = this.configManager.get('idleThreshold', 300) * 1000; // Convert to milliseconds
    }

    public start(): void {
        if (this.isRunning) {
            this.logger.warn('ActivityDetector is already running');
            return;
        }

        this.isRunning = true;
        this.lastActivityTime = Date.now();
        this.currentIdleState = false;

        this.logger.info(`Starting activity detector with idle threshold: ${this.idleThresholdMs}ms`);

        this.setupEventListeners();
        this.startIdleDetection();
    }

    public stop(): void {
        if (!this.isRunning) {
            return;
        }

        this.logger.info('Stopping activity detector');

        this.isRunning = false;
        this.cleanupEventListeners();
        this.stopIdleDetection();
        this.activityEvents = [];
    }

    public updateConfiguration(): void {
        const newIdleThresholdMs = this.configManager.get('idleThreshold', 300) * 1000;

        if (newIdleThresholdMs !== this.idleThresholdMs) {
            this.logger.info(`Updating idle threshold from ${this.idleThresholdMs}ms to ${newIdleThresholdMs}ms`);
            this.idleThresholdMs = newIdleThresholdMs;
        }
    }

    public isActive(): boolean {
        return this.isRunning;
    }

    public isIdle(): boolean {
        return this.currentIdleState;
    }

    public getLastActivityTime(): number {
        return this.lastActivityTime;
    }

    public getTimeSinceLastActivity(): number {
        return Date.now() - this.lastActivityTime;
    }

    public getRecentActivityEvents(minutes = 5): ActivityEvent[] {
        const cutoffTime = Date.now() - (minutes * 60 * 1000);
        return this.activityEvents.filter(event => event.timestamp.getTime() >= cutoffTime);
    }

    public getActivityStats(hours = 1): {
        totalEvents: number;
        eventsByType: { [key: string]: number };
        activeTimeMs: number;
        idleTimeMs: number;
    } {
        const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);
        const recentEvents = this.activityEvents.filter(event => event.timestamp.getTime() >= cutoffTime);

        const eventsByType: { [key: string]: number } = {};
        recentEvents.forEach(event => {
            eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
        });

        // Calculate active vs idle time (simplified)
        const totalTimeMs = hours * 60 * 60 * 1000;
        const timeSinceLastActivity = this.getTimeSinceLastActivity();
        const activeTimeMs = Math.max(0, totalTimeMs - Math.min(timeSinceLastActivity, totalTimeMs));

        return {
            totalEvents: recentEvents.length,
            eventsByType,
            activeTimeMs,
            idleTimeMs: totalTimeMs - activeTimeMs
        };
    }

    private setupEventListeners(): void {
        // File open/close events
        this.eventListeners.push(
            vscode.workspace.onDidOpenTextDocument((document) => {
                this.recordActivity({
                    type: 'file_open',
                    timestamp: new Date(),
                    file: document.fileName,
                    language: document.languageId,
                    metadata: {
                        scheme: document.uri.scheme,
                        lineCount: document.lineCount
                    }
                });
            })
        );

        this.eventListeners.push(
            vscode.workspace.onDidCloseTextDocument((document) => {
                this.recordActivity({
                    type: 'file_close',
                    timestamp: new Date(),
                    file: document.fileName,
                    language: document.languageId
                });
            })
        );

        // File edit events
        this.eventListeners.push(
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.contentChanges.length > 0) {
                    this.recordActivity({
                        type: 'file_edit',
                        timestamp: new Date(),
                        file: event.document.fileName,
                        language: event.document.languageId,
                        metadata: {
                            changes: event.contentChanges.length,
                            totalChanges: event.contentChanges.reduce((sum, change) => sum + change.text.length, 0)
                        }
                    });
                }
            })
        );

        // File save events
        this.eventListeners.push(
            vscode.workspace.onDidSaveTextDocument((document) => {
                this.recordActivity({
                    type: 'file_save',
                    timestamp: new Date(),
                    file: document.fileName,
                    language: document.languageId,
                    metadata: {
                        lineCount: document.lineCount
                    }
                });
            })
        );

        // Selection change events
        this.eventListeners.push(
            vscode.window.onDidChangeTextEditorSelection((event) => {
                this.recordActivity({
                    type: 'selection_change',
                    timestamp: new Date(),
                    file: event.textEditor.document.fileName,
                    language: event.textEditor.document.languageId,
                    metadata: {
                        selections: event.selections.length,
                        kind: event.kind
                    }
                });
            })
        );

        // Cursor position events
        this.eventListeners.push(
            vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
                this.recordActivity({
                    type: 'cursor_move',
                    timestamp: new Date(),
                    file: event.textEditor.document.fileName,
                    language: event.textEditor.document.languageId,
                    metadata: {
                        visibleRanges: event.visibleRanges.length
                    }
                });
            })
        );

        // Focus change events
        this.eventListeners.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                this.recordActivity({
                    type: 'focus_change',
                    timestamp: new Date(),
                    file: editor?.document.fileName,
                    language: editor?.document.languageId,
                    metadata: {
                        hasEditor: !!editor
                    }
                });
            })
        );

        this.logger.debug('Activity event listeners setup completed');
    }

    private cleanupEventListeners(): void {
        this.eventListeners.forEach(listener => listener.dispose());
        this.eventListeners = [];
        this.logger.debug('Activity event listeners cleaned up');
    }

    private recordActivity(event: ActivityEvent): void {
        if (!this.isRunning) {
            return;
        }

        this.lastActivityTime = Date.now();

        // Update idle state
        if (this.currentIdleState) {
            this.currentIdleState = false;
            this.logger.debug('User became active');
        }

        const shouldTrackActivityEvents = this.configManager.get('analytics.enableActivityTracking', true);
        if (!shouldTrackActivityEvents) {
            return;
        }

        this.activityEvents.push(event);

        // Keep only recent events (last hour)
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        this.activityEvents = this.activityEvents.filter(e => e.timestamp.getTime() >= oneHourAgo);

        this.logger.debug(`Recorded activity: ${event.type} at ${event.file || 'unknown file'}`);

        if (this.onActivity) {
            Promise.resolve(this.onActivity(event)).catch((error) => {
                const logError = error instanceof Error ? error : new Error(String(error));
                this.logger.error('Failed to handle activity event', logError);
            });
        }
    }

    private startIdleDetection(): void {
        this.idleCheckTimer = setInterval(() => {
            this.checkIdleState();
        }, 10000); // Check every 10 seconds
    }

    private stopIdleDetection(): void {
        if (this.idleCheckTimer) {
            clearInterval(this.idleCheckTimer);
            this.idleCheckTimer = null;
        }
    }

    private checkIdleState(): void {
        const timeSinceLastActivity = this.getTimeSinceLastActivity();
        const wasIdle = this.currentIdleState;
        this.currentIdleState = timeSinceLastActivity >= this.idleThresholdMs;

        if (this.currentIdleState !== wasIdle) {
            if (this.currentIdleState) {
                this.logger.debug(`User became idle (no activity for ${Math.round(timeSinceLastActivity / 1000)}s)`);
            } else {
                this.logger.debug('User became active');
            }
        }
    }
}
