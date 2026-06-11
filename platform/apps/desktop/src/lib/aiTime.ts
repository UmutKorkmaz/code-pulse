import type { AiActivityRow, AiSession, CodingSessionSummary } from '@codepulse/client/browser';

/** A tool counts as "running now" when its open session saw activity within this window. */
export const RUNNING_NOW_WINDOW_MS = 10 * 60 * 1000;

/** Per-tool AI time for a single local day. All time fields are milliseconds. */
export interface AiToolDayTime {
    tool: string;
    /** Wall-clock run time in milliseconds (open sessions count up to now). */
    runMs: number;
    /** Gap-windowed active work time in milliseconds. */
    activeMs: number;
    sessions: number;
}

/**
 * Local calendar day key (YYYY-MM-DD) matching the daemon's
 * AiActivityRow.day format.
 */
export function localDayKey(date: Date = new Date()): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Aggregate /v1/ai/activity rows for one local day into per-tool totals,
 * sorted by active time (then run time) descending.
 */
export function aggregateAiToolTimes(
    rows: AiActivityRow[],
    dayKey: string = localDayKey()
): AiToolDayTime[] {
    const byTool = new Map<string, AiToolDayTime>();

    for (const row of rows) {
        if (row.day !== dayKey) {
            continue;
        }

        const tool = row.tool ?? 'unknown';
        const existing = byTool.get(tool);
        byTool.set(tool, {
            tool,
            runMs: (existing?.runMs ?? 0) + (row.runMs ?? 0),
            activeMs: (existing?.activeMs ?? 0) + (row.activeMs ?? 0),
            sessions: (existing?.sessions ?? 0) + (row.sessions ?? 0)
        });
    }

    return [...byTool.values()].sort((a, b) => b.activeMs - a.activeMs || b.runMs - a.runMs);
}

/**
 * Total human active coding time in milliseconds for one local day.
 * CodingSessionSummary.duration is seconds; normalized to ms here.
 */
export function sumHumanActiveMs(
    sessions: CodingSessionSummary[],
    dayKey: string = localDayKey()
): number {
    return sessions.reduce((total, session) => {
        const startMs = Date.parse(session.startTime ?? '');
        if (!Number.isFinite(startMs) || localDayKey(new Date(startMs)) !== dayKey) {
            return total;
        }

        const durationMs = typeof session.duration === 'number' ? session.duration * 1000 : 0;
        return total + durationMs;
    }, 0);
}

/**
 * Tools that have an open AI session (no ended_at) whose last activity
 * falls within the recency window (default ~10 minutes).
 */
export function findRunningTools(
    sessions: AiSession[],
    nowMs: number = Date.now(),
    windowMs: number = RUNNING_NOW_WINDOW_MS
): Set<string> {
    const running = new Set<string>();

    for (const session of sessions) {
        if (!session.isActive) {
            continue;
        }

        const lastActivityMs = Date.parse(session.lastActivityAt ?? '');
        if (Number.isFinite(lastActivityMs) && nowMs - lastActivityMs <= windowMs) {
            running.add(session.tool ?? 'unknown');
        }
    }

    return running;
}

/** Compact duration label from milliseconds, e.g. "<1m", "37m", "3h 5m". */
export function formatDurationMs(durationMs: number): string {
    const minutes = Math.round(durationMs / 60_000);
    if (minutes < 1) {
        return '<1m';
    }
    if (minutes < 60) {
        return `${minutes}m`;
    }
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
