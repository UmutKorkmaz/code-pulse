import * as assert from 'assert';
import { calculateGoalProgress, getMilestoneCrossings } from '../../src/analytics/GoalProgress';

suite('GoalProgress Test Suite', () => {
    test('Should return an empty progress state when no goal is set', () => {
        const now = new Date('2026-04-16T09:00:00.000Z');
        const progress = calculateGoalProgress({
            scope: 'global',
            window: 'daily',
            goalMinutes: 0,
            currentMs: 15 * 60 * 1000,
            windowStart: new Date('2026-04-16T08:00:00.000Z'),
            now
        });

        assert.strictEqual(progress.isGoalSet, false);
        assert.strictEqual(progress.isGoalMet, false);
        assert.strictEqual(progress.percent, 0);
        assert.strictEqual(progress.currentMinutes, 0);
        assert.strictEqual(progress.remainingMinutes, 0);
        assert.strictEqual(progress.etaAt, null);
    });

    test('Should calculate progress, remaining time, and ETA', () => {
        const windowStart = new Date('2026-04-16T08:00:00.000Z');
        const now = new Date('2026-04-16T09:00:00.000Z');
        const progress = calculateGoalProgress({
            scope: 'project',
            window: 'daily',
            goalMinutes: 120,
            currentMs: 60 * 60 * 1000,
            windowStart,
            now
        });

        assert.strictEqual(progress.isGoalSet, true);
        assert.strictEqual(progress.isGoalMet, false);
        assert.strictEqual(progress.currentMinutes, 60);
        assert.strictEqual(progress.percent, 50);
        assert.strictEqual(progress.remainingMinutes, 60);
        assert.strictEqual(progress.etaAt, new Date('2026-04-16T10:00:00.000Z').getTime());
    });

    test('Should report crossed milestones in order', () => {
        assert.deepStrictEqual(getMilestoneCrossings(10, 24), []);
        assert.deepStrictEqual(getMilestoneCrossings(24, 76), [25, 50, 75]);
        assert.deepStrictEqual(getMilestoneCrossings(76, 100), [100]);
        assert.deepStrictEqual(getMilestoneCrossings(80, 60), []);
    });
});
