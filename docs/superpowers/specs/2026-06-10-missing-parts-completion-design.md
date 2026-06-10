# Missing-Parts Completion — Design

Date: 2026-06-10
Status: approved (user pre-approved via "spawn workflow to complete missing parts, don't ask questions, you choose the best")

## Context

A claim-by-claim verification (54 claims) of the Code Pulse feature summary found 6 absent
features and 3 partial ones. This design closes all 9. Everything else is already present
and verified; two prior fix rounds hardened security and ingestion (see
`.claude/plans/codepulse-platform-loop.md` and the audit results).

## Scope — the nine gaps

### Extension security (Opus-reviewed)

**1. ApiServer auth on localhost + timing-safe compare** (`src/api/ApiServer.ts`)
Current: token compared with plain `!==` (line ~158) and the entire auth block only runs
when `allowExternalConnections` is true — localhost binds serve the full coding-activity
DB with no auth.
Design: require auth on **every** bind. Token source: `codepulse.apiToken` setting if set,
else auto-generate once and persist to a 0600 file under the extension's global storage
(mirrors the daemon's `~/.codepulse/token` pattern). Add a `codepulse.copyApiToken`
command (clipboard) so external consumers can discover it. Compare with
`crypto.timingSafeEqual` on length-checked buffers. Validate the `Host` header is loopback
(DNS-rebinding defense, same approach as the daemon). Update `test/suite/apiServer.test.ts`.

### Extension correctness/performance (Fable)

**2. WAL mode** (`src/storage/DatabaseManager.ts`)
`PRAGMA journal_mode = WAL` at init alongside existing `foreign_keys`/`busy_timeout`;
log the returned mode and degrade gracefully if the FS refuses WAL.

**3. CloudSync queue cap** (`src/storage/CloudSync.ts`)
Bound `pendingSessions`/`pendingActivities` (500 sessions / 2000 activities), drop-oldest
with a single rate-limited warning log.

**4. Async logger** (`src/utils/Logger.ts`)
Timer flush and rotation switch to `fs.promises` with a serialized write chain
(no interleaved appends). Error-level inline flush and the final dispose() flush stay
synchronous for crash/shutdown safety.

**5. Single-query streak** (`src/analytics/AnalyticsEngine.ts` + `DatabaseManager`)
Replace the up-to-365-query per-day loop with one SQL query returning distinct local
session dates (newest first); compute the streak in JS over that list.

**6. Configured heartbeat in scorer** (`src/analytics/ProductivityScorer.ts`)
Inject the heartbeat interval (from ConfigManager) at construction
(`TimeTracker.ts:144` call site); replace the hardcoded 2-minute constant in
`expectedHeartbeats`.

**7. Async git branch** (`src/detectors/ProjectDetector.ts`)
`execFileSync` → promisified `execFile` (same args/timeout hardening); make the call
chain async. No behavior change beyond non-blocking.

**8. Real activity/segment merge** (`src/storage/DatabaseManager.ts`)
`mergeSnapshot` currently accepts `activities`/`segments` and silently drops them.
Insert both with `INSERT OR IGNORE` keyed on their natural unique ids (inspect schema;
add a UNIQUE index via idempotent migration only if none exists).

### Platform (Fable)

**9a. Real Timeline page** (`platform/apps/desktop/src/pages/Timeline.svelte`)
Replace the stub with a day-grouped chronological feed merging coding sessions and AI
sessions, with the same loading/error/empty-state patterns as Tokens/Recovery. Fetch-once
on mount (consistent with the other pages; live WS updates remain a deferred follow-up).

**9b. `GET /v1/sessions` daemon endpoint** (prerequisite for 9a)
The daemon persists coding sessions but exposes no endpoint. Add
`DatabaseV5.listSessions({ days, limit })` (clamped), `GET /v1/sessions` in
`http/server.ts` (auth-required, added to capabilities), `fetchSessions` in both node and
browser clients, plus an endpoint test in `platform/tests/http/`.

**9c. Buildable Tauri app** (`platform/apps/desktop/src-tauri/`)
Generate the missing `icons/` set with `@tauri-apps/cli icon` (source: rasterize
`extension/icon.svg` to 1024px via macOS `qlmanage`/`sips` if possible, else upscale the
128px PNG — buildability over beauty). Generate `Cargo.lock` with
`cargo generate-lockfile` and prove compilation with `cargo check` (cargo 1.94.1 is
installed). Full `tauri build` is best-effort with a timeout; not a gate.

## Out of scope (unchanged deferred items)

Privacy tiers/path hashing, registry update CDN channel, login service install,
WebSocket live updates in desktop/extension, spool compaction.

## Execution

One workflow: three parallel fix agents with disjoint file ownership (ApiServer security
on Opus 4.8 per model-routing policy; extension perf and platform agents on Fable 5),
then full verification (platform build + tests, root typecheck + lint, real VS Code test
host), an Opus security review of the ApiServer diff + Fable quality review of the rest,
and a conditional fixup round. Baselines that must not regress: platform 68 passing,
extension 52 passing in the VS Code host, lint 0 errors.

## Testing

- ApiServer: 401-everywhere-without-token, timing-safe path, Host-header rejection,
  copy-token command registration.
- DatabaseManager: WAL pragma active; merge round-trip including activities/segments.
- AnalyticsEngine: streak result parity with the old loop on fixture data.
- Platform: `/v1/sessions` auth + shape + clamping.
- Existing suites must stay green.
