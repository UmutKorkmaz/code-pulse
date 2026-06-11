export type GoalWindow = 'daily' | 'weekly';
export type GoalScope = 'global' | 'project';
export type GoalMilestone = 25 | 50 | 75 | 100;

export const GOAL_MILESTONES: GoalMilestone[] = [25, 50, 75, 100];

export interface GoalProgress {
    scope: GoalScope;
    window: GoalWindow;
    goalMinutes: number;
    currentMinutes: number;
    percent: number;
    remainingMinutes: number;
    isGoalSet: boolean;
    isGoalMet: boolean;
    etaAt: number | null;
}

export interface GoalStatus {
    global: {
        daily: GoalProgress;
        weekly: GoalProgress;
    };
    project: {
        projectName: string | null;
        daily: GoalProgress;
        weekly: GoalProgress;
    };
    now: number;
}

export interface GoalProgressInput {
    scope: GoalScope;
    window: GoalWindow;
    goalMinutes: number;
    currentMs: number;
    windowStart: Date;
    now: Date;
}

const MINUTE_MS = 60 * 1000;

function toNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toMinutes(ms: number): number {
    return Math.max(0, ms) / MINUTE_MS;
}

function toMilliseconds(minutes: number): number {
    return Math.max(0, minutes) * MINUTE_MS;
}

function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

function formatClampedNumber(value: unknown): number {
    return toNumber(value);
}

function estimateEtaMs(goalMs: number, currentMs: number, windowStart: Date, now: Date): number | null {
    if (goalMs <= 0 || currentMs <= 0 || currentMs >= goalMs) {
        return currentMs >= goalMs ? now.getTime() : null;
    }

    const elapsedWindowMs = Math.max(1, now.getTime() - windowStart.getTime());
    const paceMsPerMs = currentMs / elapsedWindowMs;
    if (paceMsPerMs <= 0) {
        return null;
    }

    const remainingMs = Math.max(0, goalMs - currentMs);
    return now.getTime() + remainingMs / paceMsPerMs;
}

export function calculateGoalProgress(input: GoalProgressInput): GoalProgress {
    const goalMinutes = Math.floor(formatClampedNumber(input.goalMinutes));
    const currentMs = toNumber(input.currentMs);
    const now = input.now instanceof Date ? input.now : new Date();
    const hasGoal = goalMinutes > 0;
    const goalMs = hasGoal ? toMilliseconds(goalMinutes) : 0;

    if (!hasGoal) {
        return {
            scope: input.scope,
            window: input.window,
            goalMinutes: 0,
            currentMinutes: 0,
            percent: 0,
            remainingMinutes: 0,
            isGoalSet: false,
            isGoalMet: false,
            etaAt: null
        };
    }

    const percent = clampPercent((Math.max(0, currentMs) / goalMs) * 100);
    return {
        scope: input.scope,
        window: input.window,
        goalMinutes,
        currentMinutes: toMinutes(currentMs),
        percent,
        remainingMinutes: Math.max(0, toMinutes(goalMs - currentMs)),
        isGoalSet: true,
        isGoalMet: currentMs >= goalMs,
        etaAt: estimateEtaMs(goalMs, currentMs, input.windowStart, now)
    };
}

export function getMilestoneCrossings(previousPercent: number, currentPercent: number): GoalMilestone[] {
    const previous = clampPercent(previousPercent);
    const current = clampPercent(currentPercent);
    if (current <= previous) {
        return [];
    }

    return GOAL_MILESTONES.filter(milestone => previous < milestone && current >= milestone);
}

export type LegacyGoalProgressEntry = GoalProgress;
export interface LegacyGoalProgressSnapshot {
    asOf: string;
    dailyWindowStart: string;
    weeklyWindowStart: string;
    global: {
        daily: LegacyGoalProgressEntry;
        weekly: LegacyGoalProgressEntry;
    };
    project: {
        projectName: string | null;
        daily: LegacyGoalProgressEntry;
        weekly: LegacyGoalProgressEntry;
    };
}
