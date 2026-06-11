# Code Pulse Roadmap — 8-Feature Implementation Plan (Index)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each linked sub-plan uses checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship eight independent high-value features that elevate Code Pulse from "time logger" to "coding coach + production-grade analytics tool."

**Architecture:** Each feature is a self-contained add-on — either a new module under `src/`, a new webview card, or a new provider. No feature depends on another; they can ship in any order. Two features (Focus Mode + Rich Notifications) share a lightweight `EventBus` pattern that's introduced in the Focus Mode plan and reused.

**Tech Stack:** TypeScript 4.9 · mocha/assert · SQLite (sqlite3 node module) · VS Code Extension API · Chart.js (in webview) · Node `crypto` stdlib (for encryption) · axios (already in deps).

---

## Execution order (recommended)

Ship in this sequence — earliest = fastest to visible value:

| # | Plan | Est. tasks | Why this order |
|---|------|-----------|----------------|
| 1 | [Contribution Heatmap](2026-04-12-01-heatmap.md) | 12 | Reuses `daily_rollups` table. Biggest visual payoff. Standalone. |
| 2 | [Goals & Streaks](2026-04-12-02-goals-streaks.md) | 14 | Uses existing `calculateCodingStreak`. Adds config + one webview card. |
| 3 | [Custom Date Range Picker](2026-04-12-08-date-range-picker.md) | 10 | Small, replaces an existing dropdown. Good palate-cleanser. |
| 4 | [CSV/Excel Export](2026-04-12-07-csv-export.md) | 9 | Tiny feature. Extends `exportData` command. |
| 5 | [Focus Mode / Pomodoro](2026-04-12-03-focus-mode.md) | 18 | Introduces `EventBus` used by #7 (Notifications). |
| 6 | [Rich Notifications System](2026-04-12-05-notifications.md) | 16 | Depends on the event bus from Focus Mode. |
| 7 | [Encrypted Cloud Sync](2026-04-12-06-encrypted-sync.md) | 11 | Wraps existing `SyncManager` snapshots in AES-GCM. |
| 8 | [Git Commit Correlation](2026-04-12-04-git-correlation.md) | 15 | Schema migration + git poller. Biggest single feature. |

Total: **~105 tasks** across the eight sub-plans.

---

## Cross-cutting conventions

These apply to every sub-plan. Engineers executing a sub-plan should scan this section first.

### Testing harness

- Tests live in `test/suite/*.test.ts` — follow the existing mocha/assert style.
- Integration tests that touch the database use a temp SQLite path under `os.tmpdir()` + `fs.mkdtempSync`, not the production globalStorageUri.
- Do **not** mock VS Code API unless unavoidable — use `vscode.ExtensionMode.Test` (already set in the mock context in `test/suite/timeTracker.test.ts:17`).
- Run a single test with: `npm run compile && node ./out/test/runTest.js`.
- To run just one file, set env var `MOCHA_GREP="<regex>"` before compile (you'll add support for this on first task that needs it).

### Schema migrations

- Any new table → bump `DatabaseManager.SCHEMA_VERSION` by 1, add a `migrateToVN()` method, register in `migrateSchema()`.
- Current version: **v3** (see `src/storage/DatabaseManager.ts:30`). Next feature to add a table (Git Commit Correlation) takes v4.
- Always use `CREATE TABLE IF NOT EXISTS`. Always add an index on any foreign key column.

### Config conventions

- New config keys → `"codepulse.<feature>.<setting>"` in `package.json` under `contributes.configuration.properties`.
- Defaults must be sensible — user should get value out-of-box without any config.
- All config reads through `ConfigManager.get<T>(key, defaultValue)` — never call `vscode.workspace.getConfiguration()` directly.

### Webview contract

- Extension → webview: `webview.postMessage({ command: '...', data: {...} })`.
- Webview → extension: `vscode.postMessage({ command: '...', ... })` handled in `WebviewProvider.handleWebviewMessage`.
- All user-derived strings MUST pass through `escapeHtml()` before entering `innerHTML`. There is an existing helper in both `main.js` and `dashboard.js`.
- All canvas colors MUST come from `cssVar('--vscode-*')` — never hardcode `#007acc` etc. Theme tokens only.

### Commit style

- Use conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`.
- Each task ends with a `git add <specific files> && git commit -m "..."` step.
- Do NOT `git add -A` (project rule — see `~/.claude/rules/common/git-workflow.md`).
- Attribution is disabled globally — no `Co-Authored-By` trailer.

### File-size budget

- TypeScript files should stay under 600 lines where practical. If a file grows above that during a task, split it at responsibility boundaries. Existing exceptions: `DatabaseManager.ts`, `ProjectDetector.ts` — don't pile more onto them without splitting.

---

## Shared types (referenced by multiple sub-plans)

These exist or will be introduced. Sub-plans reference them by name.

```typescript
// Existing — src/tracker/TimeTracker.ts:15
interface CodingSession {
    id: string;
    startTime: Date;
    endTime?: Date;
    duration: number;
    idleDuration: number;
    project: string;
    language: string;
    file: string;
    branch?: string;
    isActive: boolean;
    heartbeats: number;
    keystrokes: number;
    linesAdded: number;
    linesRemoved: number;
    productivityScore?: number;
}

// Existing — src/storage/DatabaseManager.ts:18
interface DailyRollup {
    date: string;        // YYYY-MM-DD (local)
    totalTime: number;   // ms of active time
    idleTime: number;
    sessionCount: number;
    keystrokes: number;
    linesAdded: number;
    linesRemoved: number;
    updatedAt?: string;
}

// NEW — introduced in Focus Mode plan, reused by Notifications
interface CodePulseEvent {
    type: 'session-started' | 'session-ended' | 'focus-started'
        | 'focus-break' | 'focus-completed' | 'goal-met' | 'long-session';
    at: Date;
    payload?: Record<string, unknown>;
}
```

---

## How to pick up a sub-plan

1. Open the sub-plan file. Read the **Architecture** and **Files** blocks at the top.
2. Execute tasks in order. Each task has 5 steps: write test → verify fails → implement → verify passes → commit.
3. After each task's commit, run `npm run ci` as a sanity check (lint + typecheck + build). If it fails, the task is not done.
4. When all tasks in a sub-plan are done, move to the next sub-plan per the execution order above.

---

## Self-review checklist (for the planner)

All 8 user-requested features have a sub-plan. Architectural dependencies identified (Focus Mode → Notifications event bus). Cross-cutting conventions documented once, not repeated per plan. Shared types defined in one place. Execution order rationalized by dependency and effort.
