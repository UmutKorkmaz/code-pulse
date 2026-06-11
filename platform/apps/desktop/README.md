# Code Pulse Desktop

Minimal Tauri 2 + Svelte scaffold for the Code Pulse desktop app. Talks to the local `codepulse-d` daemon via `@codepulse/client`.

## Prerequisites

- Node.js 20+
- Rust toolchain (for `tauri dev` / `tauri build`) — optional for frontend-only work
- A running Code Pulse daemon (`codepulse-d` or `npm run start -w @codepulse/daemon`)

Build the shared client package first:

```bash
cd platform
npm install
npm run build -w @codepulse/client
```

## Development

### Frontend only (Vite)

```bash
cd platform/apps/desktop
npm install
npm run dev
```

Open http://localhost:1420.

In the browser, set daemon connection via env (the client package reads `~/.codepulse/` only under Node):

```bash
VITE_DAEMON_HOST=127.0.0.1 VITE_DAEMON_PORT=9477 npm run dev
```

#### Dev mode and the daemon token

In dev mode the Vite origin is `http://localhost:1420`. This is **not** a trusted
desktop-shell origin, so `/v1/bootstrap` deliberately returns ports/host only and
**no bearer token** — random localhost browser tabs must never be handed the token.

Authenticated daemon endpoints therefore need the token supplied explicitly. Read
it from `~/.codepulse/token` into `VITE_DAEMON_TOKEN` when starting Vite:

```bash
VITE_DAEMON_TOKEN=$(cat ~/.codepulse/token) npm run dev
```

The packaged Tauri shell (origins `tauri://localhost`, `https://tauri.localhost`,
`http://tauri.localhost`) is the only client that receives the token from
`/v1/bootstrap`, so it needs no `VITE_DAEMON_TOKEN`.

### Full desktop shell (Tauri)

Requires Rust/Cargo:

```bash
cd platform/apps/desktop
npm run tauri:dev
```

## Build

```bash
npm run build          # Vite production bundle → dist/
npm run tauri:build    # Native app (requires Cargo)
```

## Native build

`npm run tauri:build` needs a Rust toolchain (`cargo`) plus the generated app
icons in `src-tauri/icons/`. The icon set is checked in; regenerate it from the
1024×1024 source PNG with the Tauri CLI:

```bash
cd platform/apps/desktop
npx @tauri-apps/cli icon src-tauri/icon-source.png
```

`src-tauri/icon-source.png` is rasterized from `extension/icon.svg` (macOS:
`qlmanage -t -s 1024 -o <outdir> extension/icon.svg`). `src-tauri/Cargo.lock`
is committed for reproducible native builds; `cargo check` inside `src-tauri/`
verifies the Rust crate compiles without producing bundles.

## Layout

| Path | Purpose |
|------|---------|
| `src/App.svelte` | Shell with compact / medium / wide responsive layout |
| `src/lib/daemon.ts` | Daemon helpers (`/v1/status`, `/v1/sessions`, `/v1/ai/*`, snapshots) |
| `src/pages/` | Pages: Home, Timeline, Tokens, Recovery, AI Sources |
| `src-tauri/` | Tauri 2 Rust stub (`tauri.conf.json`, `Cargo.toml`) |

## Daemon endpoints

The app uses:

- `GET /v1/status` — daemon health and tracking summary
- `GET /v1/sessions` — coding sessions for the Timeline feed
- `GET /v1/ai/sessions` — AI sessions for the Timeline feed
- `GET /v1/ai/tokens` — token usage aggregates (via `getTodayTokens()`)
- `GET /v1/snapshots` + restore — Recovery page

Start the daemon before exercising live data in the UI.