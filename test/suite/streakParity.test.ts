import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnalyticsEngine, CodingStreak } from '../../src/analytics/AnalyticsEngine';
import { DatabaseManager } from '../../src/storage/DatabaseManager';
import { CodingSession } from '../../src/tracker/TimeTracker';
import { ConfigManager } from '../../src/utils/ConfigManager';
import { formatLocalDate } from '../../src/utils/DateUtils';

/**
 * Reference implementation of the streak calculation as it existed before the
 * single-query rewrite: one getSessionsByDate query per day, walking backwards
 * from the current date. The new implementation must match it exactly.
 */
async function calculateStreakWithPerDayQueries(
    databaseManager: DatabaseManager,
    currentDate: Date
): Promise<CodingStreak> {
    let currentStreak = 0;
    let longestStreak = 0;
    let currentStreakStart: Date | undefined;
    let longestStreakEnd: Date | undefined;

    const date = new Date(currentDate);
    date.setHours(23, 59, 59, 999); // End of day

    for (;;) {
        const dateString = formatLocalDate(date);
        const sessions = await databaseManager.getSessionsByDate(dateString);
        const hasCoding = sessions.length > 0 && sessions.some(s => s.duration > 0);

        if (hasCoding) {
            currentStreak++;
            if (!currentStreakStart) {
                currentStreakStart = new Date(date);
            }

            if (currentStreak > longestStreak) {
                longestStreak = currentStreak;
                longestStreakEnd = new Date(date);
            }
        } else if (currentStreak > 0) {
            // End of current streak
            break;
        }

        date.setDate(date.getDate() - 1);

        // Prevent infinite loop - check only last 365 days
        if (new Date().getTime() - date.getTime() > 365 * 24 * 60 * 60 * 1000) {
            break;
        }
    }

    return {
        currentStreak,
        longestStreak,
        streakStartDate: currentStreakStart,
        streakEndDate: longestStreakEnd
    };
}

suite('Coding Streak Parity Test Suite', () => {
    let tempDir: string;
    let databaseManager: DatabaseManager;
    let analyticsEngine: AnalyticsEngine;

    suiteSetup(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepulse-streak-test-'));
        databaseManager = new DatabaseManager(tempDir);
        await databaseManager.initialize();

        const configManagerStub = {
            get: <T>(key: string, defaultValue?: T): T => defaultValue as T,
            shouldTrackFilenames: () => true
        } as unknown as ConfigManager;

        analyticsEngine = new AnalyticsEngine(databaseManager, configManagerStub);
    });

    suiteTeardown(async () => {
        await databaseManager.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    setup(async () => {
        await databaseManager.resetAllData();
    });

    function makeSession(daysAgo: number, duration: number): CodingSession {
        const startTime = new Date();
        startTime.setDate(startTime.getDate() - daysAgo);
        startTime.setHours(12, 0, 0, 0); // Local noon avoids timezone edge cases

        return {
            id: `streak-session-${daysAgo}-${duration}`,
            startTime,
            endTime: new Date(startTime.getTime() + Math.max(duration, 1)),
            duration,
            idleDuration: 0,
            project: 'code-pulse',
            language: 'typescript',
            file: 'src/extension.ts',
            isActive: false,
            heartbeats: 1,
            keystrokes: 10,
            linesAdded: 1,
            linesRemoved: 0
        };
    }

    async function assertParity(): Promise<CodingStreak> {
        const now = new Date();
        const expected = await calculateStreakWithPerDayQueries(databaseManager, now);
        const actual = await analyticsEngine.getCodingStreak(now);

        assert.deepStrictEqual(actual, expected, 'New streak must match the per-day-query reference');
        return actual;
    }

    test('Parity with no sessions at all', async function () {
        this.timeout(30000);

        const streak = await assertParity();
        assert.strictEqual(streak.currentStreak, 0);
        assert.strictEqual(streak.longestStreak, 0);
        assert.strictEqual(streak.streakStartDate, undefined);
        assert.strictEqual(streak.streakEndDate, undefined);
    });

    test('Parity for an unbroken streak ending today', async function () {
        this.timeout(30000);

        await databaseManager.saveSession(makeSession(0, 60000));
        await databaseManager.saveSession(makeSession(1, 120000));
        await databaseManager.saveSession(makeSession(2, 90000));

        const streak = await assertParity();
        assert.strictEqual(streak.currentStreak, 3);
        assert.strictEqual(streak.longestStreak, 3);
    });

    test('Parity for a streak starting yesterday (no coding today)', async function () {
        this.timeout(30000);

        await databaseManager.saveSession(makeSession(1, 120000));
        await databaseManager.saveSession(makeSession(2, 90000));

        const streak = await assertParity();
        assert.strictEqual(streak.currentStreak, 2);
    });

    test('Parity when a gap breaks the streak after today', async function () {
        this.timeout(30000);

        await databaseManager.saveSession(makeSession(0, 60000));
        // Day 1 has no coding — the streak must stop at 1.
        await databaseManager.saveSession(makeSession(2, 90000));
        await databaseManager.saveSession(makeSession(3, 90000));

        const streak = await assertParity();
        assert.strictEqual(streak.currentStreak, 1);
    });

    test('Parity for an older streak found after skipping empty days', async function () {
        this.timeout(30000);

        // Days 0-3 empty; the scan keeps walking back and finds a 2-day streak.
        await databaseManager.saveSession(makeSession(4, 90000));
        await databaseManager.saveSession(makeSession(5, 90000));

        const streak = await assertParity();
        assert.strictEqual(streak.currentStreak, 2);
    });

    test('Parity when zero-duration sessions do not count as coding days', async function () {
        this.timeout(30000);

        await databaseManager.saveSession(makeSession(0, 0));
        await databaseManager.saveSession(makeSession(1, 120000));
        await databaseManager.saveSession(makeSession(2, 90000));

        const streak = await assertParity();
        assert.strictEqual(streak.currentStreak, 2, 'A zero-duration day today must not extend the streak');
    });
});
