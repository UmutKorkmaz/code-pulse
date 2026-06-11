<script lang="ts">
    import { onMount } from 'svelte';
    import {
        fetchAiSessions,
        fetchSessions,
        type AiSessionRow,
        type CodingSessionRow
    } from '../lib/daemon';

    interface TimelineEntry {
        key: string;
        kind: 'coding' | 'ai';
        badge: string;
        title: string;
        detail: string;
        startMs: number;
        endMs: number | null;
        durationMs: number | null;
        activeDurationMs: number | null;
        inputTokens: number | null;
        outputTokens: number | null;
    }

    interface DayGroup {
        label: string;
        entries: TimelineEntry[];
    }

    let groups: DayGroup[] = [];
    let loading = true;
    let error = '';

    onMount(async () => {
        try {
            const [coding, ai] = await Promise.all([fetchSessions(), fetchAiSessions()]);
            groups = buildDayGroups([
                ...coding.map(toCodingEntry).filter(isEntry),
                ...ai.map(toAiEntry).filter(isEntry)
            ]);
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        } finally {
            loading = false;
        }
    });

    function isEntry(entry: TimelineEntry | null): entry is TimelineEntry {
        return entry !== null;
    }

    function toCodingEntry(session: CodingSessionRow, index: number): TimelineEntry | null {
        const startMs = Date.parse(session.startTime ?? '');
        if (!Number.isFinite(startMs)) {
            return null;
        }

        const endMs = session.endTime ? Date.parse(session.endTime) : Number.NaN;
        const durationMs = typeof session.duration === 'number' ? session.duration * 1000 : null;
        const detailParts = [session.language, session.branch].filter(Boolean);

        return {
            key: `coding-${session.id ?? index}`,
            kind: 'coding',
            badge: 'coding',
            title: session.project ?? 'Unknown project',
            detail: detailParts.join(' · '),
            startMs,
            endMs: Number.isFinite(endMs) ? endMs : null,
            durationMs,
            activeDurationMs: null,
            inputTokens: null,
            outputTokens: null
        };
    }

    function toAiEntry(session: AiSessionRow, index: number): TimelineEntry | null {
        const startMs = Date.parse(session.startedAt ?? '');
        if (!Number.isFinite(startMs)) {
            return null;
        }

        const endMs = session.endedAt ? Date.parse(session.endedAt) : Number.NaN;

        return {
            key: `ai-${session.id ?? index}`,
            kind: 'ai',
            badge: session.tool ?? 'ai',
            title: session.tool ?? 'AI session',
            detail: session.model ?? '',
            startMs,
            endMs: Number.isFinite(endMs) ? endMs : null,
            durationMs: typeof session.durationMs === 'number' ? session.durationMs : null,
            activeDurationMs:
                typeof session.activeDurationMs === 'number' ? session.activeDurationMs : null,
            inputTokens: session.inputTokens ?? null,
            outputTokens: session.outputTokens ?? null
        };
    }

    function buildDayGroups(entries: TimelineEntry[]): DayGroup[] {
        const sorted = [...entries].sort((a, b) => b.startMs - a.startMs);
        const byDay = new Map<string, DayGroup>();

        for (const entry of sorted) {
            const date = new Date(entry.startMs);
            const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
            const existing = byDay.get(key);
            if (existing) {
                existing.entries.push(entry);
            } else {
                byDay.set(key, {
                    label: date.toLocaleDateString(undefined, {
                        weekday: 'long',
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric'
                    }),
                    entries: [entry]
                });
            }
        }

        return [...byDay.values()];
    }

    function formatTime(ms: number): string {
        return new Date(ms).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function formatTimeRange(entry: TimelineEntry): string {
        const start = formatTime(entry.startMs);
        return entry.endMs === null ? `${start} – now` : `${start} – ${formatTime(entry.endMs)}`;
    }

    function formatDuration(durationMs: number): string {
        const minutes = Math.round(durationMs / 60_000);
        if (minutes < 1) {
            return '<1m';
        }
        if (minutes < 60) {
            return `${minutes}m`;
        }
        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }

    function formatTokens(entry: TimelineEntry): string {
        const input = entry.inputTokens ?? 0;
        const output = entry.outputTokens ?? 0;
        return `${input.toLocaleString()} in · ${output.toLocaleString()} out`;
    }

    function hasTokens(entry: TimelineEntry): boolean {
        return (entry.inputTokens ?? 0) > 0 || (entry.outputTokens ?? 0) > 0;
    }
</script>

<section class="page">
    <header class="page-header">
        <h1>Timeline</h1>
        <p class="subtitle">Coding and AI sessions, newest first, grouped by day.</p>
    </header>

    {#if loading}
        <p class="muted">Loading timeline…</p>
    {:else if error}
        <div class="card error">
            <strong>Error</strong>
            <p>{error}</p>
        </div>
    {:else if groups.length === 0}
        <div class="card empty">
            <p>No sessions yet. Coding sessions arrive from the extension; AI sessions from scanners.</p>
        </div>
    {:else}
        {#each groups as group}
            <div class="day-group">
                <h2 class="day-label">{group.label}</h2>
                <ul class="entry-list">
                    {#each group.entries as entry (entry.key)}
                        <li class="card entry">
                            <div class="entry-head">
                                <span class="badge badge--{entry.kind}">{entry.badge}</span>
                                <span class="time-range">{formatTimeRange(entry)}</span>
                            </div>
                            <div class="entry-body">
                                <strong class="title">{entry.title}</strong>
                                {#if entry.detail}
                                    <span class="detail">{entry.detail}</span>
                                {/if}
                            </div>
                            <div class="entry-meta">
                                {#if entry.kind === 'ai'}
                                    {#if entry.durationMs !== null}
                                        <span>ran {formatDuration(entry.durationMs)}</span>
                                    {/if}
                                    {#if entry.activeDurationMs !== null}
                                        <span>worked {formatDuration(entry.activeDurationMs)}</span>
                                    {/if}
                                {:else if entry.durationMs !== null}
                                    <span>{formatDuration(entry.durationMs)}</span>
                                {/if}
                                {#if hasTokens(entry)}
                                    <span>{formatTokens(entry)}</span>
                                {/if}
                            </div>
                        </li>
                    {/each}
                </ul>
            </div>
        {/each}
    {/if}
</section>

<style>
    .page-header h1 {
        margin: 0 0 0.25rem;
        font-size: 1.5rem;
    }

    .subtitle {
        margin: 0;
        color: var(--cp-muted);
    }

    .card {
        background: var(--cp-surface);
        border: 1px solid var(--cp-border);
        border-radius: var(--cp-radius);
        padding: 1rem 1.25rem;
    }

    .card.error {
        margin-top: 1.25rem;
        border-color: var(--cp-danger);
        background: rgba(239, 107, 107, 0.08);
    }

    .card.empty {
        margin-top: 1.25rem;
        color: var(--cp-muted);
    }

    .day-group {
        margin-top: 1.25rem;
    }

    .day-label {
        margin: 0 0 0.6rem;
        font-size: 0.85rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--cp-muted);
    }

    .entry-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.5rem;
    }

    .entry {
        display: grid;
        gap: 0.35rem;
        padding: 0.75rem 1rem;
    }

    .entry-head {
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    .badge {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 0.15rem 0.45rem;
        border-radius: 999px;
        border: 1px solid var(--cp-border);
        color: var(--cp-muted);
    }

    .badge--coding {
        color: #6dd58c;
        border-color: rgba(109, 213, 140, 0.35);
    }

    .badge--ai {
        color: #8ec5ff;
        border-color: rgba(142, 197, 255, 0.35);
    }

    .time-range {
        font-size: 0.8rem;
        color: var(--cp-muted);
    }

    .entry-body {
        display: flex;
        align-items: baseline;
        gap: 0.6rem;
        flex-wrap: wrap;
    }

    .title {
        font-size: 0.95rem;
    }

    .detail {
        font-size: 0.8rem;
        color: var(--cp-muted);
    }

    .entry-meta {
        display: flex;
        gap: 0.75rem;
        font-size: 0.8rem;
        color: var(--cp-muted);
    }

    .muted {
        color: var(--cp-muted);
    }
</style>
