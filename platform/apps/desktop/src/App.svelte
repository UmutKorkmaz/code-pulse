<script lang="ts">
    import Home from './pages/Home.svelte';
    import Timeline from './pages/Timeline.svelte';
    import Tokens from './pages/Tokens.svelte';
    import Recovery from './pages/Recovery.svelte';
    import AiSources from './pages/AiSources.svelte';

    type PageId = 'home' | 'timeline' | 'tokens' | 'recovery' | 'ai-sources';

    const navItems: { id: PageId; label: string; short: string }[] = [
        { id: 'home', label: 'Home', short: 'Home' },
        { id: 'timeline', label: 'Timeline', short: 'Time' },
        { id: 'tokens', label: 'Tokens', short: 'Tok' },
        { id: 'recovery', label: 'Recovery', short: 'Rec' },
        { id: 'ai-sources', label: 'AI Sources', short: 'AI' }
    ];

    let activePage: PageId = 'home';
</script>

<div class="shell" data-layout="auto">
    <aside class="sidebar" aria-label="Primary navigation">
        <div class="brand">
            <span class="brand-mark" aria-hidden="true">◉</span>
            <div class="brand-copy">
                <strong>Code Pulse</strong>
                <span class="brand-tag">desktop</span>
            </div>
        </div>

        <nav class="nav">
            {#each navItems as item}
                <button
                    type="button"
                    class:active={activePage === item.id}
                    on:click={() => (activePage = item.id)}
                >
                    <span class="nav-label">{item.label}</span>
                    <span class="nav-short">{item.short}</span>
                </button>
            {/each}
        </nav>
    </aside>

    <div class="main-column">
        <header class="topbar">
            <div class="topbar-title">
                <span class="layout-badge layout-badge--compact">compact</span>
                <span class="layout-badge layout-badge--medium">medium</span>
                <span class="layout-badge layout-badge--wide">wide</span>
            </div>
        </header>

        <main class="content">
            {#if activePage === 'home'}
                <Home />
            {:else if activePage === 'timeline'}
                <Timeline />
            {:else if activePage === 'tokens'}
                <Tokens />
            {:else if activePage === 'recovery'}
                <Recovery />
            {:else}
                <AiSources />
            {/if}
        </main>
    </div>

    <nav class="bottom-nav" aria-label="Mobile navigation">
        {#each navItems as item}
            <button
                type="button"
                class:active={activePage === item.id}
                on:click={() => (activePage = item.id)}
            >
                {item.short}
            </button>
        {/each}
    </nav>
</div>

<style>
    .shell {
        --shell-sidebar-width: var(--cp-nav-width);
        min-height: 100vh;
        display: grid;
        grid-template-columns: var(--shell-sidebar-width) 1fr;
        grid-template-rows: 1fr auto;
        grid-template-areas:
            'sidebar main'
            'sidebar main';
    }

    .sidebar {
        grid-area: sidebar;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        padding: 1.25rem 1rem;
        background: var(--cp-surface);
        border-right: 1px solid var(--cp-border);
    }

    .brand {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.25rem 0.5rem;
    }

    .brand-mark {
        color: var(--cp-accent);
        font-size: 1.25rem;
    }

    .brand-copy {
        display: flex;
        flex-direction: column;
        line-height: 1.2;
    }

    .brand-tag {
        font-size: 0.75rem;
        color: var(--cp-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
    }

    .nav {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
    }

    .nav button,
    .bottom-nav button {
        border: 1px solid transparent;
        background: transparent;
        color: var(--cp-text);
        border-radius: 8px;
        padding: 0.65rem 0.75rem;
        text-align: left;
        transition: background 120ms ease, border-color 120ms ease;
    }

    .nav button:hover,
    .bottom-nav button:hover {
        background: var(--cp-surface-2);
    }

    .nav button.active,
    .bottom-nav button.active {
        background: var(--cp-accent-soft);
        border-color: rgba(91, 141, 239, 0.35);
        color: #fff;
    }

    .nav-short {
        display: none;
    }

    .main-column {
        grid-area: main;
        display: flex;
        flex-direction: column;
        min-width: 0;
    }

    .topbar {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding: 0.75rem 1.25rem;
        border-bottom: 1px solid var(--cp-border);
        background: rgba(15, 17, 23, 0.6);
        backdrop-filter: blur(8px);
    }

    .layout-badge {
        display: none;
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--cp-muted);
        border: 1px solid var(--cp-border);
        border-radius: 999px;
        padding: 0.2rem 0.55rem;
    }

    .content {
        flex: 1;
        padding: 1.25rem;
        overflow: auto;
    }

    .bottom-nav {
        display: none;
        grid-column: 1 / -1;
        position: sticky;
        bottom: 0;
        padding: 0.5rem;
        gap: 0.35rem;
        background: var(--cp-surface);
        border-top: 1px solid var(--cp-border);
    }

    .bottom-nav button {
        flex: 1;
        text-align: center;
        padding: 0.55rem 0.25rem;
        font-size: 0.8rem;
    }

    /* wide: full sidebar labels */
    @media (min-width: 1024px) {
        .shell {
            --shell-sidebar-width: var(--cp-nav-width);
        }

        .layout-badge--wide {
            display: inline-flex;
        }
    }

    /* medium: narrower sidebar, abbreviated labels */
    @media (min-width: 640px) and (max-width: 1023px) {
        .shell {
            --shell-sidebar-width: 4.5rem;
        }

        .brand-copy,
        .nav-label {
            display: none;
        }

        .nav-short {
            display: inline;
        }

        .nav button {
            text-align: center;
            padding-inline: 0.35rem;
        }

        .layout-badge--medium {
            display: inline-flex;
        }
    }

    /* compact: bottom nav, hide sidebar */
    @media (max-width: 639px) {
        .shell {
            grid-template-columns: 1fr;
            grid-template-areas:
                'main'
                'bottom';
        }

        .sidebar {
            display: none;
        }

        .bottom-nav {
            display: flex;
        }

        .content {
            padding: 1rem;
        }

        .layout-badge--compact {
            display: inline-flex;
        }
    }
</style>