<script lang="ts">
    import { onMount } from 'svelte';
    import { fetchRegistry, type RegistryScannerRow } from '../lib/daemon';

    let scanners: RegistryScannerRow[] = [];
    let loading = true;
    let error = '';
    let updatedAt = '';

    onMount(async () => {
        try {
            const data = await fetchRegistry();
            scanners = data.scanners ?? [];
            updatedAt = data.updatedAt ?? '';
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        } finally {
            loading = false;
        }
    });
</script>

<section class="page">
    <header class="page-header">
        <h1>AI Sources</h1>
        <p class="subtitle">Curated scanners installed on this device.</p>
    </header>

    {#if loading}
        <p class="muted">Loading registry…</p>
    {:else if error}
        <div class="card error">
            <strong>Registry unavailable</strong>
            <p>{error}</p>
        </div>
    {:else if scanners.length === 0}
        <div class="card empty">
            <p>No scanners installed. Start the daemon to seed the bundled catalog.</p>
        </div>
    {:else}
        <div class="card">
            {#if updatedAt}
                <p class="updated">Updated {new Date(updatedAt).toLocaleString()}</p>
            {/if}
            <ul class="scanner-list">
                {#each scanners as scanner}
                    <li>
                        <div class="scanner-head">
                            <strong>{scanner.displayName ?? scanner.id}</strong>
                            <span class="trust trust--{scanner.trust ?? 'community'}">{scanner.trust ?? 'community'}</span>
                        </div>
                        <div class="scanner-meta">
                            <span>{scanner.id}</span>
                            <span>v{scanner.version ?? '—'}</span>
                            <span class:enabled={scanner.enabled} class:disabled={!scanner.enabled}>
                                {scanner.enabled ? 'enabled' : 'disabled'}
                            </span>
                        </div>
                    </li>
                {/each}
            </ul>
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
        background: var(--cp-surface);
        border: 1px solid var(--cp-border);
        border-radius: var(--cp-radius);
        padding: 1rem 1.25rem;
    }

    .card.error {
        border-color: var(--cp-danger);
        background: rgba(239, 107, 107, 0.08);
    }

    .card.empty,
    .muted {
        color: var(--cp-muted);
    }

    .updated {
        margin: 0 0 0.75rem;
        font-size: 0.8rem;
        color: var(--cp-muted);
    }

    .scanner-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.65rem;
    }

    .scanner-list li {
        padding: 0.75rem;
        border: 1px solid var(--cp-border);
        border-radius: 8px;
        background: var(--cp-surface-2);
    }

    .scanner-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.75rem;
    }

    .trust {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 0.15rem 0.45rem;
        border-radius: 999px;
        border: 1px solid var(--cp-border);
    }

    .trust--official {
        color: #8ec5ff;
        border-color: rgba(142, 197, 255, 0.35);
    }

    .scanner-meta {
        margin-top: 0.35rem;
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        font-size: 0.8rem;
        color: var(--cp-muted);
    }

    .enabled {
        color: #6dd58c;
    }

    .disabled {
        color: var(--cp-muted);
    }
</style>