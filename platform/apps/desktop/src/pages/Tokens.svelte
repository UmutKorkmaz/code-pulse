<script lang="ts">
    import { onMount } from 'svelte';
    import { fetchAiTokens } from '../lib/daemon';
    import type { TokenAggregate } from '@codepulse/client/browser';

    let tokens: TokenAggregate[] = [];
    let error: string | null = null;
    let loading = true;

    onMount(async () => {
        try {
            tokens = await fetchAiTokens();
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        } finally {
            loading = false;
        }
    });
</script>

<section class="page">
    <header class="page-header">
        <h1>Tokens</h1>
        <p class="subtitle">AI token usage from GET /v1/ai/tokens.</p>
    </header>

    {#if loading}
        <p class="muted">Loading token aggregates…</p>
    {:else if error}
        <div class="card error">{error}</div>
    {:else if tokens.length === 0}
        <div class="card placeholder">No token data for today.</div>
    {:else}
        <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>Tool</th>
                        <th>Model</th>
                        <th>Input</th>
                        <th>Output</th>
                        <th>Total</th>
                    </tr>
                </thead>
                <tbody>
                    {#each tokens as row}
                        <tr>
                            <td>{row.tool ?? '—'}</td>
                            <td>{row.model ?? '—'}</td>
                            <td>{row.inputTokens ?? 0}</td>
                            <td>{row.outputTokens ?? 0}</td>
                            <td>{row.totalTokens ?? 0}</td>
                        </tr>
                    {/each}
                </tbody>
            </table>
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

    .card {
        margin-top: 1.25rem;
        padding: 1rem 1.25rem;
        border-radius: var(--cp-radius);
        background: var(--cp-surface);
        border: 1px solid var(--cp-border);
    }

    .card.error {
        border-color: var(--cp-danger);
        color: var(--cp-danger);
    }

    .card.placeholder {
        color: var(--cp-muted);
        border-style: dashed;
    }

    .table-wrap {
        margin-top: 1.25rem;
        overflow-x: auto;
        border: 1px solid var(--cp-border);
        border-radius: var(--cp-radius);
    }

    table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9rem;
    }

    th,
    td {
        padding: 0.65rem 0.85rem;
        text-align: left;
        border-bottom: 1px solid var(--cp-border);
    }

    th {
        background: var(--cp-surface-2);
        color: var(--cp-muted);
        font-weight: 600;
    }

    tr:last-child td {
        border-bottom: none;
    }

    .muted {
        color: var(--cp-muted);
    }
</style>