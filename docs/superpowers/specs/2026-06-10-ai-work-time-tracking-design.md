# AI Work-Time Tracking — Design

Date: 2026-06-10
Status: awaiting user approval

## Goal

Measure, per AI tool (Claude Code, Codex, Cursor, Cline, Droid, Kilo), two distinct time
metrics, continuously, and show them unified with human coding time in one panel — on the
desktop app AND the VS Code dashboard:

- **Run time** — wall-clock while the tool's process is alive ("Claude has been open 3h").
- **Active work time** — time the tool actually worked ("worked for 37m 39s"), derived
  from the density of its activity events (log lines, token usage, hook events).

Also: detect AI tools running *inside VS Code terminals* and AI *extensions* (Claude,
Codex, Cline, Copilot…), and merge every detection source into a single session per tool
so nothing is double-counted.

## Why the current code can't do this (recon facts)

- `ps -eo comm=` captures names only — no PID/uptime; process-detected `ai_sessions`
  rows are **never ended** (no "process gone" path; `endAiSession` only fires from log
  events), so wall-clock `durationMs` grows forever (`server.ts:317-322`).
- No activity computation exists: no gap windowing, no `last_activity_at`, no duration
  column on `ai_sessions` — but the raw timestamps exist (`ai_tool_events.occurred_at`,
  `ai_token_usage.recorded_at`).
- Protocol has no `ai.session.updated` event, no `terminal` evidence type, no
  activity fields on `AISession`; `source` is mislabeled `'hook'` for process detections.
- Confidence model half-built: process=0.4 flat, log hardcoded 0.9, extension scoring
  dead (reports never passed), terminal absent (strategy §4.5 says .4/.3/.2/.1).
- Extension is forward-only (no GET methods), has zero terminal/extensions API usage;
  dashboard is a static card grid with a clean message protocol to extend.
- Desktop Home shows no time data; `/v1/ai/sessions` is unclamped + N+1; human durations
  are seconds while AI durations are ms.

## Design

### 1. Protocol (packages/protocol)

- Add `ai.session.updated` to the `DaemonEvent` union + WS event list, mirroring
  `session.updated`.
- `AISession` gains optional `lastActivityAt?: string`, `activeDuration?: number`
  (seconds, same unit as human `CodingSession.duration`), `runDuration?: number`.
- Add `'terminal'` to `EvidenceType` (capability + source enums already have it).
- Validate `AISession.source` against the enum (today it's a blind cast).

### 2. Daemon: process session lifecycle (apps/daemon scanner)

- ProcessWatcher captures `ps -eo pid=,etime=,comm=` → per (scanner, tool): instance
  count + earliest start (etime → run start). Maintain a presence map:
  - appear → `ai.session.started` (source `'process'` — fixes the `'hook'` mislabel)
  - present → in-memory `lastSeenAt` (the existing 60s re-detect debounce stays for
    `ai.tool.detected` events)
  - gone for ≥ 2 consecutive polls (~10s grace) → `ai.session.ended`
- Startup sweep: close any open process-source session whose `last_activity_at` (or
  `started_at`) is older than 10 minutes — heals today's immortal sessions.

### 3. Active-work accumulator (apps/daemon + core DB)

- Migration v7 (idempotent, existing pattern): `ai_sessions.last_activity_at TEXT`,
  `ai_sessions.active_duration INTEGER DEFAULT 0` (seconds).
- An `ActivityAccumulator` in the ingest path: every event attached to an AI session
  (tool event, token usage, hook event) feeds gap-based windowing —
  gap ≤ **300s** (configurable `activityGapSeconds`) extends the current window; a
  larger gap closes it and adds its length to `active_duration`; an isolated event
  grants a **30s** minimum. Persisted through the existing serialized write queue,
  batched with the event's transaction.
- On window close / session end, emit a throttled `ai.session.updated` envelope
  (≤ 1 per 30s per session) → WS broadcast for future live UIs.

### 4. API (apps/daemon http + clients)

- New `GET /v1/ai/activity?days=N` — single SQL aggregate per day × tool:
  `{ runMs, activeMs, sessions, inputTokens, outputTokens }`, clamped like
  `/v1/sessions`, object envelope `{activity, total}`, listed in capabilities.
- Fix `/v1/ai/sessions`: clamp `limit`, replace the N+1 token loop with one grouped
  query, add `activeDurationMs`, `lastActivityAt`, `isActive`.
- Unit rule: **all API time fields are milliseconds**; documented in client types.
- `fetchAiActivity` added to node + browser clients.

### 5. VS Code extension: terminal + extension detection (src/)

- `TerminalAiDetector` (interval+disposable pattern like HeartbeatManager):
  `onDidOpenTerminal`/`onDidCloseTerminal` + 10s poll; one `ps -ax -o pid=,ppid=,comm=`
  per poll builds a child-process map; AI CLI names (claude, codex, droid, cline, kilo,
  cursor-agent) found under any terminal's `processId` → forward `ai.tool.detected`
  envelopes (evidence type `'terminal'`, src `'vscode'`) through the existing
  DaemonClient ingest path. Daemon-absent fallback: keep local state so the dashboard
  still shows "running in terminal".
- `AiExtensionDetector`: scan `vscode.extensions.all` on activation +
  `onDidChange` against a known-ID list (Claude Code, Copilot, Cline, Codex, Kilo,
  Cursor-adjacent); active AI extensions forwarded as `extension_report` evidence and
  shown as an inventory list in the dashboard.
- DaemonClient gains public read methods: `getAiActivity(days)`, `getAiSessions(limit)`
  (reusing its private `request()`).

### 6. Matching / dedup (single source of truth per tool)

- All sources funnel to the same daemon attach point (`findActiveAiSession` by tool):
  terminal/extension/process/log detections of the same tool join the **same open
  session**. Confidence becomes the strategy-§4.5 sum of *distinct* observed sources
  (process .4 + log .3 + extension .2 + terminal .1, capped at 1.0), stored with the
  union of sources in session metadata. This is what guarantees the "single panel" never
  double-counts a tool seen by both the global watcher and the VS Code terminal scanner.

### 7. Dashboards

- **Desktop Home**: third card — "Today: You vs AI": human active time (from
  `/v1/sessions`) vs per-tool `activeMs`/`runMs` bars with a "running now" badge
  (open session + recent `lastActivityAt`), fed by `fetchAiActivity` added to
  `loadDaemonSnapshot`'s `Promise.all`. Timeline gains the active-vs-run split per entry.
- **VS Code dashboard**: new "AI Tools" card in the existing grid: per tool —
  status (running in terminal / background / idle), today's active time, run time,
  tokens; plus the active-AI-extensions list. New `updateAiData` message from
  WebviewProvider (joins the existing 60s refresh), rendered like the Projects/Languages
  breakdown cards. Daemon offline → local terminal/extension state only, with a hint.
- Live WS updates remain deferred (consistent with prior scope decisions); the 60s pull
  plus local "running" state covers the need first.

## Out of scope

WebSocket live dashboards, per-project AI attribution (needs cwd capture — follow-up),
Windows `tasklist` support, CPU-based busy detection.

## Defaults chosen

activity gap 300s · isolated-event grant 30s · disappearance grace 2 polls ·
stale-session sweep 10 min · `ai.session.updated` throttle 30s · API unit ms.

## Delivery plan (one workflow, 4 stages)

1. **Foundations**: protocol additions + DB migration v7 + source-label fix (one agent).
2. **Daemon**: presence lifecycle + accumulator + `/v1/ai/activity` + sessions fixes
   (one agent; tests for window math, lifecycle, endpoint clamps).
3. **Extension**: terminal + extension detectors + DaemonClient reads + dashboard card
   (one agent; tests with stubbed `ps`/extensions).
4. **Desktop**: Home panel + Timeline split + client methods (one agent), then full
   verification (platform + VS Code host suites), dual review (security: new `ps`
   spawning + ingest surface on Opus), conditional fixup.

Baselines that must not regress: platform 74, extension 74, lint 0 errors.
