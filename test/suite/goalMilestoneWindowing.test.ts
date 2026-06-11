import * as assert from 'assert';
import * as vscode from 'vscode';
import { TimeTracker, DailyStats } from '../../src/tracker/TimeTracker';
import { DatabaseManager } from '../../src/storage/DatabaseManager';
import { ConfigManager } from '../../src/utils/ConfigManager';
import { Logger } from '../../src/utils/Logger';
import { formatLocalDate } from '../../src/utils/DateUtils';

const DAILY_GOAL_MINUTES = 60;
const WEEKLY_GOAL_MINUTES = 120;
const MINUTE_MS = 60 * 1000;
const TEST_PROJECT = 'milestone-project';

function percentOfGoalMs(percent: number): number {
    return (DAILY_GOAL_MINUTES * MINUTE_MS * percent) / 100;
}

function percentOfWeeklyGoalMs(percent: number): number {
    return (WEEKLY_GOAL_MINUTES * MINUTE_MS * percent) / 100;
}

function makeDailyStats(totalTime: number): DailyStats {
    return {
        date: formatLocalDate(new Date()),
        totalTime,
        activeTime: totalTime,
        idleTime: 0,
        sessionCount: 1,
        projects: { [TEST_PROJECT]: totalTime },
        languages: { typescript: totalTime },
        files: {},
        productivity: { score: 0, coding: 0, debugging: 0, building: 0 }
    };
}

suite('TimeTracker Goal Milestone Windowing Test Suite', () => {
    let timeTracker: TimeTracker;
    let logger: Logger;
    let messages: string[] = [];
    let todaysTotalMs = 0;
    let weeklyTotalMs = 0;
    let weeklyGoalMinutes = 0;
    let originalShowInformationMessage: typeof vscode.window.showInformationMessage;

    suiteSetup(() => {
        const mockContext = {
            subscriptions: [],
            workspaceState: {
                get: () => undefined,
                update: async () => {
                    /* noop */
                },
                keys: () => []
            },
            globalState: {
                get: () => undefined,
                update: async () => {
                    /* noop */
                },
                keys: () => [],
                setKeysForSync: () => {
                    /* noop */
                }
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

        logger = new Logger(__dirname, 'debug');

        // Stub goal configuration: a 60 minute global daily goal with milestone notifications on.
        const configManager = new ConfigManager();
        configManager.isCloudSyncEnabled = () => false;
        configManager.isGoalTrackingEnabled = () => true;
        configManager.shouldNotifyWhenOnTrack = () => true;
        configManager.getGlobalDailyGoalMinutes = () => DAILY_GOAL_MINUTES;
        configManager.getGlobalWeeklyGoalMinutes = () => weeklyGoalMinutes;
        configManager.isProjectGoalConfigured = () => false;

        // The milestone path never touches the database — stats access is stubbed below.
        const databaseManager = {} as unknown as DatabaseManager;

        timeTracker = new TimeTracker(mockContext, databaseManager, configManager, logger);

        // Drive goal progress from controlled stats instead of the analytics engine.
        (timeTracker as any).getTodaysStats = async (): Promise<DailyStats> => makeDailyStats(todaysTotalMs);
        (timeTracker as any).getWeeklyStats = async (): Promise<DailyStats[]> => [makeDailyStats(weeklyTotalMs)];

        originalShowInformationMessage = vscode.window.showInformationMessage;
        (vscode.window as any).showInformationMessage = (message: string) => {
            messages.push(message);
            return Promise.resolve(undefined);
        };
    });

    suiteTeardown(() => {
        (vscode.window as any).showInformationMessage = originalShowInformationMessage;
        if (logger) {
            logger.dispose();
        }
    });

    setup(() => {
        messages = [];
        todaysTotalMs = 0;
        weeklyTotalMs = 0;
        weeklyGoalMinutes = 0;
        timeTracker.resetGoalProgressState();
    });

    async function computeMilestones(): Promise<void> {
        await (timeTracker as any).updateGoalProgressAndMilestones(TEST_PROJECT);
    }

    function getMilestoneState(): Map<string, Set<number>> {
        return (timeTracker as any).goalMilestoneState as Map<string, Set<number>>;
    }

    /**
     * Re-keys the reached-milestone sets to yesterday's date, simulating that they were
     * recorded before a daily window rollover.
     */
    function advanceDailyWindowByOneDay(): void {
        const state = getMilestoneState();
        const todayKey = formatLocalDate(new Date());
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayKey = formatLocalDate(yesterday);

        for (const key of Array.from(state.keys())) {
            if (key.endsWith(`:${todayKey}`)) {
                const reached = state.get(key);
                state.delete(key);
                if (reached) {
                    state.set(`${key.slice(0, key.length - todayKey.length)}${yesterdayKey}`, reached);
                }
            }
        }
    }

    test('First computation after activation seeds the baseline without notifications', async () => {
        // 55% of the daily goal was already reached before activation.
        todaysTotalMs = percentOfGoalMs(55);
        await computeMilestones();

        assert.strictEqual(messages.length, 0, 'Baseline seeding must not produce notifications');

        // Recomputing at the same progress stays silent as well.
        await computeMilestones();
        assert.strictEqual(messages.length, 0);

        // Already-passed milestones (25, 50) were baselined into the reached set, not just skipped.
        const dailyKey = `global:daily:${formatLocalDate(new Date())}`;
        const reached = getMilestoneState().get(dailyKey);
        assert.ok(reached, 'Baseline should create a reached-milestone set for the current window');
        assert.deepStrictEqual(
            Array.from(reached || []).sort((a, b) => a - b),
            [25, 50]
        );
    });

    test('A milestone crossing during the session notifies exactly once', async () => {
        todaysTotalMs = percentOfGoalMs(55);
        await computeMilestones();
        assert.strictEqual(messages.length, 0);

        // Crossing 75% notifies once.
        todaysTotalMs = percentOfGoalMs(80);
        await computeMilestones();
        assert.strictEqual(messages.length, 1);
        assert.ok(messages[0].includes('Global Daily'), `Unexpected message: ${messages[0]}`);
        assert.ok(messages[0].includes('75%'), `Unexpected message: ${messages[0]}`);

        // Dip below the milestone and cross it again within the same window — no re-notify.
        todaysTotalMs = percentOfGoalMs(55);
        await computeMilestones();
        todaysTotalMs = percentOfGoalMs(80);
        await computeMilestones();
        assert.strictEqual(messages.length, 1, 'Already-reached milestones must not re-notify in the same window');
    });

    test('Milestones can notify again after the daily window start advances', async () => {
        todaysTotalMs = percentOfGoalMs(55);
        await computeMilestones();
        todaysTotalMs = percentOfGoalMs(80);
        await computeMilestones();
        assert.strictEqual(messages.length, 1);

        // The daily window rolls over: reached milestones now belong to yesterday's window.
        advanceDailyWindowByOneDay();

        // The new day starts below the milestone, then crosses it again.
        todaysTotalMs = percentOfGoalMs(55);
        await computeMilestones();
        todaysTotalMs = percentOfGoalMs(80);
        await computeMilestones();

        assert.strictEqual(messages.length, 2, 'Milestone should notify again in the new daily window');
        assert.ok(messages[1].includes('75%'), `Unexpected message: ${messages[1]}`);

        // Yesterday's stale set was dropped when the new window set was created.
        const staleKeys = Array.from(getMilestoneState().keys()).filter(
            key => key.startsWith('global:daily:') && !key.endsWith(`:${formatLocalDate(new Date())}`)
        );
        assert.deepStrictEqual(staleKeys, []);
    });

    test('Weekly milestones use a high-water mark and never re-toast after a rolling-window dip', async () => {
        weeklyGoalMinutes = WEEKLY_GOAL_MINUTES;

        // First computation baselines the current percent silently.
        weeklyTotalMs = percentOfWeeklyGoalMs(55);
        await computeMilestones();
        assert.strictEqual(messages.length, 0, 'Weekly baseline seeding must not produce notifications');

        // Crossing 75% notifies once.
        weeklyTotalMs = percentOfWeeklyGoalMs(80);
        await computeMilestones();
        assert.strictEqual(messages.length, 1);
        assert.ok(messages[0].includes('Global Weekly'), `Unexpected message: ${messages[0]}`);
        assert.ok(messages[0].includes('75%'), `Unexpected message: ${messages[0]}`);

        // The ROLLING 7-day window legitimately dips at midnight (the oldest day falls out)
        // and climbs back — the same milestone must NOT toast again on consecutive days.
        weeklyTotalMs = percentOfWeeklyGoalMs(55);
        await computeMilestones();
        weeklyTotalMs = percentOfWeeklyGoalMs(80);
        await computeMilestones();
        assert.strictEqual(messages.length, 1, 'Climbing back over an already-notified milestone must not re-toast');

        // A genuinely NEW high above the previous mark still notifies.
        weeklyTotalMs = percentOfWeeklyGoalMs(100);
        await computeMilestones();
        assert.strictEqual(messages.length, 2, 'A new high-water mark crossing 100% must notify');
        assert.ok(messages[1].includes('Global Weekly'), `Unexpected message: ${messages[1]}`);
        assert.ok(messages[1].includes('completed'), `Unexpected message: ${messages[1]}`);
    });

    test('Weekly high-water mark resets only when goal configuration changes', async () => {
        weeklyGoalMinutes = WEEKLY_GOAL_MINUTES;

        weeklyTotalMs = percentOfWeeklyGoalMs(55);
        await computeMilestones();
        weeklyTotalMs = percentOfWeeklyGoalMs(80);
        await computeMilestones();
        assert.strictEqual(messages.length, 1);
        assert.ok(messages[0].includes('75%'), `Unexpected message: ${messages[0]}`);

        // A goal config change resets the mark (refreshConfiguration calls resetGoalProgressState):
        // the next computation re-baselines silently.
        timeTracker.resetGoalProgressState();
        weeklyTotalMs = percentOfWeeklyGoalMs(55);
        await computeMilestones();
        assert.strictEqual(messages.length, 1, 'Re-baselining after a config change must be silent');

        // After the reset, crossing the milestone notifies again.
        weeklyTotalMs = percentOfWeeklyGoalMs(80);
        await computeMilestones();
        assert.strictEqual(messages.length, 2, 'Milestone can notify again after the mark was reset');
        assert.ok(messages[1].includes('75%'), `Unexpected message: ${messages[1]}`);
    });
});
