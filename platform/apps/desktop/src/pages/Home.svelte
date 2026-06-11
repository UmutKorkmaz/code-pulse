<script lang="ts">
    import { onMount } from 'svelte';
    import { loadDaemonSnapshot, type DaemonSnapshot } from '../lib/daemon';
    import {
        aggregateAiToolTimes,
        findRunningTools,
        formatDurationMs,
        sumHumanActiveMs
    } from '../lib/aiTime';

    let snapshot: DaemonSnapshot | null = null;
    let loading = true;

    onMount(async () => {
        snapshot = await loadDaemonSnapshot();
        loading = false;
    });

    $: aiToolTimes = snapshot ? aggregateAiToolTimes(snapshot.aiActivity) : [];
    $: humanActiveMs = snapshot ? sumHumanActiveMs(snapshot.sessions) : 0;
    $: runningTools = snapshot ? findRunningTools(snapshot.aiSessions) : new Set<string>();
    $: maxBarMs = Math.max(
        humanActiveMs,
        ...aiToolTimes.map((toolTime) => Math.max(toolTime.runMs, toolTime.activeMs)),
        1
    );

    function barWidth(ms: number): string {
        if (ms <= 0) {
            return '0%';
        }
        return `${Math.max(2, Math.round((ms / maxBarMs) * 100))}%`;
    }
</script>

<section class="page">
    <header class="page-header">
        <h1>Home</h1>
        <p class="subtitle">Daemon status and today&apos;s AI token usage.</p>
    </header>

    {#if loading}
        <p class="muted">Connecting to daemon…</p>
    {:else if snapshot?.error}
        <div class="card error">
            <strong>Daemon unreachable</strong>
            <p>{snapshot.error}</p>
            <p class="muted">URL: {snapshot.baseUrl}</p>
        </div>
    {:else if snapshot}
        <div class="grid">
            <article class="card">
                <h2>Status</h2>
                <dl>
                    <div><dt>URL</dt><dd>{snapshot.baseUrl}</dd></div>
                    <div><dt>Service</dt><dd>{snapshot.status?.service ?? 'codepulse-d'}</dd></div>
                    <div><dt>Version</dt><dd>{snapshot.status?.version ?? '—'}</dd></div>
                    <div><dt>State</dt><dd>{snapshot.status?.status ?? '—'}</dd></div>
                    <div>
                        <dt>Tracking</dt>
                        <dd>{snapshot.status?.isTracking ? 'Yes' : 'No'}</dd>
                    </div>
                </dl>
            </article>

            <article class="card">
                <h2>Today&apos;s tokens</h2>
                {#if snapshot.tokens.length === 0}
                    <p class="muted">No token usage recorded yet.</p>
                {:else}
                    <ul class="token-list">
                        {#each snapshot.tokens as row}
                            <li>
                                <span>{row.tool ?? 'unknown'} / {row.model ?? '—'}</span>
                                <span>{row.totalTokens ?? 0} tokens</span>
                            </li>
                        {/each}
                    </ul>
                {/if}
            </article>

            <article class="card">
                <h2>Today — You vs AI</h2>
                {#if humanActiveMs === 0 && aiToolTimes.length === 0}
                    <p class="muted">No activity recorded today.</p>
                {:else}
                    <ul class="vs-list">
                        <li class="vs-row">
                            <div class="vs-head">
                                <span class="vs-name">You</span>
                                <span class="vs-value">{formatDurationMs(humanActiveMs)} active</span>
                            </div>
                            <div class="bar-track">
                                <div class="bar bar--human" style={`width: ${barWidth(humanActiveMs)}`}></div>
                            </div>
                        </li>
                        {#each aiToolTimes as toolTime (toolTime.tool)}
                            <li class="vs-row">
                                <div class="vs-head">
                                    <span class="vs-name">
                                        {toolTime.tool}
                                        {#if runningTools.has(toolTime.tool)}
                                            <span class="badge-running">running now</span>
                                        {/if}
                                    </span>
                                    <span class="vs-value">
                                        worked {formatDurationMs(toolTime.activeMs)} · ran {formatDurationMs(toolTime.runMs)}
                                    </span>
                                </div>
                                <div class="bar-track">
                                    <div class="bar bar--ai-active" style={`width: ${barWidth(toolTime.activeMs)}`}></div>
                                </div>
                                <div class="bar-track bar-track--thin">
                                    <div class="bar bar--ai-run" style={`width: ${barWidth(toolTime.runMs)}`}></div>
                                </div>
                            </li>
                        {/each}
                    </ul>
                {/if}
            </article>
        </div>
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

    .grid {
        display: grid;
        gap: 1rem;
        margin-top: 1.25rem;
    }

    .card {
        background: var(--cp-surface);
        border: 1px solid var(--cp-border);
        border-radius: var(--cp-radius);
        padding: 1rem 1.25rem;
    }

    .card h2 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
    }

    .card.error {
        border-color: var(--cp-danger);
        background: rgba(239, 107, 107, 0.08);
    }

    dl {
        margin: 0;
        display: grid;
        gap: 0.5rem;
    }

    dl div {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
    }

    dt {
        color: var(--cp-muted);
    }

    dd {
        margin: 0;
        text-align: right;
    }

    .token-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.5rem;
    }

    .token-list li {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.5rem 0;
        border-bottom: 1px solid var(--cp-border);
    }

    .token-list li:last-child {
        border-bottom: none;
    }

    .vs-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.85rem;
    }

    .vs-row {
        display: grid;
        gap: 0.3rem;
    }

    .vs-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 1rem;
    }

    .vs-name {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.9rem;
    }

    .vs-value {
        font-size: 0.8rem;
        color: var(--cp-muted);
        text-align: right;
    }

    .badge-running {
        font-size: 0.65rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 0.1rem 0.4rem;
        border-radius: 999px;
        color: #6dd58c;
        border: 1px solid rgba(109, 213, 140, 0.35);
    }

    .bar-track {
        height: 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.06);
        overflow: hidden;
    }

    .bar-track--thin {
        height: 4px;
    }

    .bar {
        height: 100%;
        border-radius: 999px;
    }

    .bar--human {
        background: #6dd58c;
    }

    .bar--ai-active {
        background: #8ec5ff;
    }

    .bar--ai-run {
        background: rgba(142, 197, 255, 0.35);
    }

    .muted {
        color: var(--cp-muted);
    }
</style>