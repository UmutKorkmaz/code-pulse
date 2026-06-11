<script lang="ts">
    import { onMount } from 'svelte';
    import {
        fetchSnapshots,
        restoreSnapshotConfirmed,
        restoreSnapshotDryRun,
        type RestorePreview,
        type SnapshotRow
    } from '../lib/daemon';

    let snapshots: SnapshotRow[] = [];
    let loading = true;
    let error = '';
    let selectedId: string | null = null;
    let preview: RestorePreview | null = null;
    let previewLoading = false;
    let restoring = false;
    let message = '';

    onMount(async () => {
        await reload();
    });

    async function reload(): Promise<void> {
        loading = true;
        error = '';
        try {
            snapshots = await fetchSnapshots(100);
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        } finally {
            loading = false;
        }
    }

    async function selectSnapshot(id: string): Promise<void> {
        selectedId = id;
        preview = null;
        previewLoading = true;
        message = '';
        try {
            preview = await restoreSnapshotDryRun(id);
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        } finally {
            previewLoading = false;
        }
    }

    async function confirmRestore(): Promise<void> {
        if (!preview?.recoveryToken || !selectedId) {
            return;
        }

        restoring = true;
        message = '';
        error = '';
        try {
            const result = await restoreSnapshotConfirmed(selectedId, preview.recoveryToken);
            message = result.restored
                ? `Restored ${result.filePath}`
                : 'No changes needed — file already matches snapshot.';
            preview = result;
            await reload();
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        } finally {
            restoring = false;
        }
    }

    function formatDate(value: string): string {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function shortPath(filePath: string): string {
        const parts = filePath.split('/');
        return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : filePath;
    }
</script>

<section class="page">
    <header class="page-header">
        <div class="header-row">
            <div>
                <h1>Recovery</h1>
                <p class="subtitle">Preview and restore file snapshots before writing.</p>
            </div>
            <button type="button" class="ghost" on:click={reload} disabled={loading}>Refresh</button>
        </div>
    </header>

    {#if loading}
        <p class="muted">Loading snapshots…</p>
    {:else if error}
        <div class="card error">
            <strong>Error</strong>
            <p>{error}</p>
        </div>
    {:else if snapshots.length === 0}
        <div class="card empty">
            <p>No snapshots yet. Pre-AI snapshots are created when the extension or hooks capture file state.</p>
        </div>
    {:else}
        <div class="layout">
            <article class="card list-card">
                <h2>Snapshots</h2>
                <ul class="snapshot-list">
                    {#each snapshots as row}
                        <li>
                            <button
                                type="button"
                                class:selected={selectedId === row.id}
                                on:click={() => selectSnapshot(row.id)}
                            >
                                <span class="type">{row.snapshot_type}</span>
                                <span class="path" title={row.file_path}>{shortPath(row.file_path)}</span>
                                <span class="meta">{formatDate(row.created_at)}</span>
                            </button>
                        </li>
                    {/each}
                </ul>
            </article>

            <article class="card detail-card">
                <h2>Restore preview</h2>
                {#if !selectedId}
                    <p class="muted">Select a snapshot to preview changes.</p>
                {:else if previewLoading}
                    <p class="muted">Running dry-run…</p>
                {:else if preview}
                    <dl class="meta-grid">
                        <div><dt>File</dt><dd title={preview.filePath}>{shortPath(preview.filePath)}</dd></div>
                        <div><dt>Project</dt><dd>{preview.project}</dd></div>
                        <div><dt>Would write</dt><dd>{preview.wouldWrite ? 'Yes' : 'No'}</dd></div>
                        <div><dt>Dry run</dt><dd>{preview.dryRun ? 'Yes' : 'No'}</dd></div>
                    </dl>

                    <pre class="diff" aria-label="Diff preview">{preview.diffPreview}</pre>

                    {#if preview.dryRun && preview.wouldWrite}
                        <button
                            type="button"
                            class="primary"
                            on:click={confirmRestore}
                            disabled={restoring || !preview.recoveryToken}
                        >
                            {restoring ? 'Restoring…' : 'Confirm restore'}
                        </button>
                    {:else if preview.dryRun}
                        <p class="muted">File already matches the snapshot — nothing to restore.</p>
                    {/if}

                    {#if message}
                        <p class="success">{message}</p>
                    {/if}
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

    .header-row {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
    }

    .subtitle {
        margin: 0;
        color: var(--cp-muted);
    }

    .layout {
        display: grid;
        gap: 1rem;
        margin-top: 1.25rem;
    }

    @media (min-width: 900px) {
        .layout {
            grid-template-columns: minmax(240px, 320px) 1fr;
        }
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

    .card.empty {
        margin-top: 1.25rem;
        color: var(--cp-muted);
    }

    .snapshot-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.35rem;
        max-height: 28rem;
        overflow: auto;
    }

    .snapshot-list button {
        width: 100%;
        display: grid;
        gap: 0.15rem;
        text-align: left;
        border: 1px solid transparent;
        background: var(--cp-surface-2);
        color: var(--cp-text);
        border-radius: 8px;
        padding: 0.6rem 0.75rem;
    }

    .snapshot-list button.selected {
        border-color: rgba(91, 141, 239, 0.45);
        background: var(--cp-accent-soft);
    }

    .type {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--cp-muted);
    }

    .path {
        font-size: 0.85rem;
        word-break: break-all;
    }

    .meta {
        font-size: 0.75rem;
        color: var(--cp-muted);
    }

    .meta-grid {
        margin: 0 0 1rem;
        display: grid;
        gap: 0.45rem;
    }

    .meta-grid div {
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
        word-break: break-all;
    }

    .diff {
        margin: 0 0 1rem;
        padding: 0.75rem;
        background: #0b0d12;
        border: 1px solid var(--cp-border);
        border-radius: 8px;
        font-size: 0.75rem;
        line-height: 1.4;
        overflow: auto;
        max-height: 18rem;
        white-space: pre-wrap;
    }

    .ghost,
    .primary {
        border-radius: 8px;
        padding: 0.55rem 0.9rem;
        border: 1px solid var(--cp-border);
        background: var(--cp-surface-2);
        color: var(--cp-text);
    }

    .primary {
        background: var(--cp-accent);
        border-color: transparent;
        color: #fff;
    }

    .muted {
        color: var(--cp-muted);
    }

    .success {
        color: #6dd58c;
        margin-top: 0.75rem;
    }
</style>