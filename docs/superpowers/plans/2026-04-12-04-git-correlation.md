# Git Commit Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link every session to git commits that happened in the same repo during the session window, so users can see "this commit took 3h 42m across 3 sessions."

**Architecture:** On session end, a new `GitCorrelator` runs `git log --since=<session start> --until=<session end>` in the session's project path. Results are stored in a new `commits` table (schema v4) with a `session_id` foreign key. The dashboard Sessions Table gains a new optional column showing commit SHAs; clicking one copies the SHA. A new "Time per commit" card aggregates time spent on each commit.

**Tech Stack:** TypeScript + `execFileSync`/`execFile` for git calls (same pattern as `ProjectDetector.getCurrentBranch`). Schema migration to v4.

---

## Files

- **Create:** `src/analytics/GitCorrelator.ts` — runs git, correlates commits to sessions (~110 lines)
- **Create:** `test/suite/gitCorrelator.test.ts` — unit tests with a real temp git repo
- **Modify:** `src/storage/DatabaseManager.ts` — bump to v4, add `commits` table + merge logic + query methods
- **Modify:** `src/tracker/TimeTracker.ts` — call correlator on session end (non-blocking)
- **Modify:** `src/ui/WebviewProvider.ts` — new `getCommitsForSessions` handler + "Time per commit" card
- **Modify:** `webview/dashboard.js` — render commits column in sessions table + commits card
- **Modify:** `webview/dashboard.css` — commit styles

---

### Task 1: Schema v4 — add commits table

**Files:** Modify `src/storage/DatabaseManager.ts`

- [ ] **Step 1: Bump SCHEMA_VERSION**

Change `SCHEMA_VERSION = 3` → `= 4`.

- [ ] **Step 2: Register new migration**

In `migrateSchema`, after the v3 block:

```typescript
if (currentVersion < 4) {
    await this.migrateToV4();
    currentVersion = 4;
    await this.setSchemaVersion(currentVersion);
}
```

- [ ] **Step 3: Implement migrateToV4**

After the existing `migrateToV3` method:

```typescript
private async migrateToV4(): Promise<void> {
    await this.run(
        `CREATE TABLE IF NOT EXISTS commits (
            sha TEXT NOT NULL,
            session_id TEXT NOT NULL,
            author_name TEXT,
            author_email TEXT,
            message TEXT,
            committed_at TEXT NOT NULL,
            project TEXT NOT NULL,
            branch TEXT,
            files_changed INTEGER DEFAULT 0,
            insertions INTEGER DEFAULT 0,
            deletions INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (sha, session_id),
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )`
    );
    await this.run('CREATE INDEX IF NOT EXISTS idx_commits_session_id ON commits(session_id)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_commits_sha ON commits(sha)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_commits_project ON commits(project)');
}
```

- [ ] **Step 4: Verify compile and migration runs**

Run: `npm run compile 2>&1 | tail -3` → clean.
Delete the existing DB (it's a dev database — regenerate with seed):

```bash
rm "$HOME/Library/Application Support/Code/User/globalStorage/codepulse.codepulse/codepulse.db"
node scripts/seed-data.js
```

Reload dev host. Open the sidebar (triggers DB init, migrations run). No errors in the extension output log.

- [ ] **Step 5: Commit**

```bash
git add src/storage/DatabaseManager.ts
git commit -m "feat: schema v4 - add commits table"
```

---

### Task 2: Add DatabaseManager.saveCommits method + test

**Files:** Modify `src/storage/DatabaseManager.ts`, create `test/suite/gitCorrelator.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/suite/gitCorrelator.test.ts`:

```typescript
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { DatabaseManager } from '../../src/storage/DatabaseManager';

suite('Commits Storage', () => {
    let dbm: DatabaseManager;
    let tmpDir: string;

    suiteSetup(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-commits-'));
        dbm = new DatabaseManager(tmpDir);
        await dbm.initialize();

        await dbm.saveSession({
            id: 'sess-1',
            startTime: new Date('2026-04-12T09:00:00Z'),
            endTime: new Date('2026-04-12T10:00:00Z'),
            duration: 3600000,
            idleDuration: 0,
            project: 'testrepo',
            language: 'typescript',
            file: 'x.ts',
            isActive: false,
            heartbeats: 0,
            keystrokes: 0,
            linesAdded: 0,
            linesRemoved: 0
        });
    });

    suiteTeardown(async () => {
        await dbm.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('saveCommits inserts and getCommitsForSession returns them', async () => {
        await dbm.saveCommits([{
            sha: 'abc123',
            sessionId: 'sess-1',
            authorName: 'Daisy',
            authorEmail: 'd@example.com',
            message: 'feat: test commit',
            committedAt: new Date('2026-04-12T09:30:00Z'),
            project: 'testrepo',
            branch: 'main',
            filesChanged: 2,
            insertions: 10,
            deletions: 3
        }]);
        const rows = await dbm.getCommitsForSession('sess-1');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].sha, 'abc123');
        assert.strictEqual(rows[0].insertions, 10);
    });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run compile 2>&1 | tail -3`
Expected: TS error — `saveCommits`, `getCommitsForSession` missing.

- [ ] **Step 3: Add type + methods to DatabaseManager.ts**

Near other exported interfaces:

```typescript
export interface CommitRecord {
    sha: string;
    sessionId: string;
    authorName?: string;
    authorEmail?: string;
    message?: string;
    committedAt: Date;
    project: string;
    branch?: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
}
```

Add these public methods near the existing save/query methods:

```typescript
public async saveCommits(commits: CommitRecord[]): Promise<void> {
    for (const c of commits) {
        await this.run(
            `INSERT OR IGNORE INTO commits (
                sha, session_id, author_name, author_email, message, committed_at,
                project, branch, files_changed, insertions, deletions
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                c.sha, c.sessionId, c.authorName ?? null, c.authorEmail ?? null,
                c.message ?? null, c.committedAt.toISOString(), c.project,
                c.branch ?? null, c.filesChanged, c.insertions, c.deletions
            ]
        );
    }
}

public async getCommitsForSession(sessionId: string): Promise<CommitRecord[]> {
    const rows = await this.all<any>('SELECT * FROM commits WHERE session_id = ? ORDER BY committed_at ASC', [sessionId]);
    return rows.map(r => this.mapRowToCommit(r));
}

public async getCommitsForSessions(sessionIds: string[]): Promise<Map<string, CommitRecord[]>> {
    const out = new Map<string, CommitRecord[]>();
    if (sessionIds.length === 0) return out;
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = await this.all<any>(`SELECT * FROM commits WHERE session_id IN (${placeholders})`, sessionIds);
    for (const r of rows) {
        const c = this.mapRowToCommit(r);
        const arr = out.get(c.sessionId) || [];
        arr.push(c);
        out.set(c.sessionId, arr);
    }
    return out;
}

private mapRowToCommit(row: any): CommitRecord {
    return {
        sha: row.sha,
        sessionId: row.session_id,
        authorName: row.author_name ?? undefined,
        authorEmail: row.author_email ?? undefined,
        message: row.message ?? undefined,
        committedAt: new Date(row.committed_at),
        project: row.project,
        branch: row.branch ?? undefined,
        filesChanged: row.files_changed ?? 0,
        insertions: row.insertions ?? 0,
        deletions: row.deletions ?? 0
    };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run compile && node ./out/test/runTest.js 2>&1 | grep -E "(passing|failing|Commits)"`
Expected: `1 passing` in Commits Storage.

- [ ] **Step 5: Commit**

```bash
git add src/storage/DatabaseManager.ts test/suite/gitCorrelator.test.ts
git commit -m "feat: add commits storage methods to DatabaseManager"
```

---

### Task 3: GitCorrelator — basic shape + dry-run test

**Files:** Create `src/analytics/GitCorrelator.ts`

- [ ] **Step 1: Write failing integration test**

Append to `test/suite/gitCorrelator.test.ts`:

```typescript
import { GitCorrelator } from '../../src/analytics/GitCorrelator';
import { execFileSync } from 'child_process';

suite('GitCorrelator (real git repo)', () => {
    let repoDir: string;

    suiteSetup(() => {
        repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-gitrepo-'));
        execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
        execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
        fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello');
        execFileSync('git', ['add', 'a.txt'], { cwd: repoDir });
        execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir });
    });

    suiteTeardown(() => {
        fs.rmSync(repoDir, { recursive: true, force: true });
    });

    test('findCommits returns commits in range', async () => {
        const correlator = new GitCorrelator();
        const end = new Date();
        const start = new Date(end.getTime() - 60 * 1000);
        const commits = await correlator.findCommits(repoDir, start, end);
        assert.strictEqual(commits.length, 1);
        assert.strictEqual(commits[0].message, 'initial');
        assert.ok(commits[0].sha.length >= 7);
    });
});
```

- [ ] **Step 2: Compile & verify fail**

Run: `npm run compile 2>&1 | tail -3`
Expected: TS error — GitCorrelator not found.

- [ ] **Step 3: Implement GitCorrelator**

Create `src/analytics/GitCorrelator.ts`:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitCommitInfo {
    sha: string;
    authorName: string;
    authorEmail: string;
    message: string;
    committedAt: Date;
    branch?: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
}

export class GitCorrelator {
    async findCommits(repoPath: string, start: Date, end: Date): Promise<GitCommitInfo[]> {
        const args = [
            'log',
            `--since=${start.toISOString()}`,
            `--until=${end.toISOString()}`,
            '--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%s',
            '--shortstat',
            '--no-merges'
        ];
        let stdout: string;
        try {
            const r = await execFileAsync('git', args, { cwd: repoPath, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
            stdout = r.stdout;
        } catch {
            return [];
        }

        return this.parseLog(stdout);
    }

    async getCurrentBranch(repoPath: string): Promise<string | undefined> {
        try {
            const r = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, timeout: 3000 });
            return r.stdout.trim() || undefined;
        } catch { return undefined; }
    }

    private parseLog(out: string): GitCommitInfo[] {
        const commits: GitCommitInfo[] = [];
        const lines = out.split('\n');
        let i = 0;
        while (i < lines.length) {
            const header = lines[i++];
            if (!header || header.trim() === '') continue;
            const parts = header.split('\x1f');
            if (parts.length < 5) continue;
            const [sha, authorName, authorEmail, committedAtIso, message] = parts;

            // Optional shortstat line ("3 files changed, 12 insertions(+), 4 deletions(-)")
            let filesChanged = 0, insertions = 0, deletions = 0;
            while (i < lines.length && lines[i].trim() === '') i++;
            if (i < lines.length && lines[i].includes('changed')) {
                const stat = lines[i++];
                const m = stat.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
                if (m) {
                    filesChanged = parseInt(m[1], 10);
                    insertions = m[2] ? parseInt(m[2], 10) : 0;
                    deletions = m[3] ? parseInt(m[3], 10) : 0;
                }
            }

            commits.push({
                sha,
                authorName,
                authorEmail,
                message,
                committedAt: new Date(committedAtIso),
                filesChanged,
                insertions,
                deletions
            });
        }
        return commits;
    }
}
```

- [ ] **Step 4: Run tests**

Run: `npm run compile && node ./out/test/runTest.js 2>&1 | grep -E "(passing|failing|GitCorrelator)"`
Expected: `1 passing`.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/GitCorrelator.ts test/suite/gitCorrelator.test.ts
git commit -m "feat: add GitCorrelator with log parsing"
```

---

### Task 4: Correlation hook on session end

**Files:** Modify `src/tracker/TimeTracker.ts`

- [ ] **Step 1: Add the correlator + path tracking**

At the top of `TimeTracker`, alongside other private fields:

```typescript
private gitCorrelator: import('../analytics/GitCorrelator').GitCorrelator;
private projectRepoPath?: string;
```

In the constructor, after `this.projectDetector = new ProjectDetector();`:

```typescript
const { GitCorrelator } = require('../analytics/GitCorrelator') as typeof import('../analytics/GitCorrelator');
this.gitCorrelator = new GitCorrelator();
```

Inside `startNewSession`, after the session has been saved:

```typescript
this.projectRepoPath = this.projectDetector.getProjectPath(document) ?? undefined;
```

- [ ] **Step 2: Fire correlation on session end (non-blocking)**

Inside `endCurrentSession`, after the fire-and-forget productivity scoring block:

```typescript
if (this.projectRepoPath && session.startTime && session.endTime) {
    const repoPath = this.projectRepoPath;
    const start = session.startTime;
    const end = session.endTime;
    const sessionId = session.id;
    const project = session.project;
    const branch = session.branch;
    this.gitCorrelator.findCommits(repoPath, start, end).then(commits => {
        if (commits.length === 0) return;
        return this.databaseManager.saveCommits(commits.map(c => ({
            sha: c.sha,
            sessionId,
            authorName: c.authorName,
            authorEmail: c.authorEmail,
            message: c.message,
            committedAt: c.committedAt,
            project,
            branch,
            filesChanged: c.filesChanged,
            insertions: c.insertions,
            deletions: c.deletions
        })));
    }).catch(err => {
        this.logger.warn('Git correlation failed', err instanceof Error ? err : new Error(String(err)));
    });
}
```

- [ ] **Step 3: Compile & commit**

```bash
npm run compile
git add src/tracker/TimeTracker.ts
git commit -m "feat: correlate session to git commits on session end"
```

---

### Task 5: Webview handler for commits-per-session

**Files:** Modify `src/ui/WebviewProvider.ts`

- [ ] **Step 1: Add case**

In `handleWebviewMessage` switch:

```typescript
case 'getCommitsForSessions':
    await this.getCommitsForSessions(message.sessionIds || [], webview);
    break;
```

- [ ] **Step 2: Handler method**

```typescript
private async getCommitsForSessions(sessionIds: string[], webview?: vscode.Webview) {
    try {
        const map = await this.databaseManager.getCommitsForSessions(sessionIds);
        const obj: Record<string, unknown[]> = {};
        map.forEach((v, k) => { obj[k] = v; });
        const target = webview ?? this._view?.webview;
        target?.postMessage({ command: 'updateCommitsForSessions', data: obj });
    } catch (error) {
        console.error('Failed to get commits:', error);
    }
}
```

- [ ] **Step 3: Compile & commit**

```bash
npm run compile
git add src/ui/WebviewProvider.ts
git commit -m "feat: add getCommitsForSessions webview handler"
```

---

### Task 6: Show commit column in sessions table

**Files:** Modify `src/ui/WebviewProvider.ts` (HTML), `webview/dashboard.js`, `webview/dashboard.css`

- [ ] **Step 1: Add `Commits` header to sessions table**

In `_getFullDashboardHtml`, find the existing `<thead>` for `.sessions-table`. Before the `Score` `<th>`, add:

```html
<th>Commits</th>
```

Update the `<tr>` inside `<tbody>` loading placeholder `colspan="7"` → `colspan="8"`.

- [ ] **Step 2: Request commits after sessions load in dashboard.js**

Inside `updateAllSessions` (where `sessionsState.raw = payload.sessions`), add at the end:

```javascript
const ids = sessionsState.raw.map(s => s.id);
vscode.postMessage({ command: 'getCommitsForSessions', sessionIds: ids });
```

Add state storage:

```javascript
sessionsState.commitsBySession = {};
```

Handle the response in `handleMessage`:

```javascript
case 'updateCommitsForSessions':
    sessionsState.commitsBySession = message.data || {};
    renderSessionsTable();
    break;
```

- [ ] **Step 3: Render a commit cell**

In `renderSessionsTable`, inside the row template, add a `<td>` **before** the score column. Replace the existing row template's `<td class="num">${escapeHtml(durStr)}</td>` → add the commits cell after the duration cell:

```javascript
const commits = (sessionsState.commitsBySession && sessionsState.commitsBySession[s.id]) || [];
const commitCell = commits.length === 0
    ? '<td class="muted">—</td>'
    : `<td class="commit-cell"><span class="commit-badge" title="${escapeHtml(commits.map(c => c.sha.slice(0,7) + ' — ' + (c.message || '')).join('\n'))}">${commits.length}</span></td>`;
```

Insert `${commitCell}` into the row template before the score `<td>`.

- [ ] **Step 4: CSS**

Append to `webview/dashboard.css`:

```css
.commit-cell { text-align: center; }
.commit-badge {
    display: inline-block;
    min-width: 22px;
    padding: 0 6px;
    height: 18px;
    line-height: 18px;
    border-radius: 9px;
    background: color-mix(in srgb, var(--cp-accent) 20%, transparent);
    color: var(--cp-accent);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    cursor: help;
}
```

- [ ] **Step 5: Compile & commit**

```bash
npm run compile
git add src/ui/WebviewProvider.ts webview/dashboard.js webview/dashboard.css
git commit -m "feat: show commit count per session in sessions table"
```

---

### Task 7: "Time per Commit" card

**Files:** Modify `src/ui/WebviewProvider.ts`, `webview/dashboard.js`, `webview/dashboard.css`

- [ ] **Step 1: HTML**

In `_getFullDashboardHtml`, below the sessions card, add:

```html
<div class="card commits-card">
    <h2 class="card-title">Time per Commit (Last 30 Days)</h2>
    <div class="commits-list" id="commitsList">
        <div class="loading-cell">Loading…</div>
    </div>
</div>
```

- [ ] **Step 2: CSS**

```css
.commits-card { grid-column: span 12; }
.commits-list { display: flex; flex-direction: column; gap: 2px; max-height: 360px; overflow-y: auto; }
.commit-row {
    display: grid;
    grid-template-columns: 70px 1fr auto auto;
    gap: 12px;
    padding: 6px 10px;
    align-items: center;
    font-size: 12px;
    border-radius: 3px;
}
.commit-row:hover { background: var(--cp-hover); }
.commit-sha {
    font-family: var(--vscode-editor-font-family);
    color: var(--cp-accent);
    font-size: 11px;
    cursor: pointer;
}
.commit-message {
    color: var(--cp-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.commit-time {
    color: var(--cp-muted);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
}
.commit-delta {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
}
.commit-delta .ins { color: var(--cp-green); margin-right: 6px; }
.commit-delta .del { color: var(--cp-red); }
```

- [ ] **Step 3: Render function**

In `dashboard.js`, after the sessions state is initialized, add an update function and subscribe to an aggregated render call inside the existing `updateCommitsForSessions` handler:

```javascript
function renderCommitsCard() {
    const list = document.getElementById('commitsList');
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);

    const commitToTotal = new Map();
    const commitInfo = new Map();
    for (const s of sessionsState.raw) {
        const commits = (sessionsState.commitsBySession || {})[s.id] || [];
        for (const c of commits) {
            commitToTotal.set(c.sha, (commitToTotal.get(c.sha) || 0) + (s.duration || 0));
            if (!commitInfo.has(c.sha)) commitInfo.set(c.sha, c);
        }
    }

    const rows = Array.from(commitToTotal.entries())
        .map(([sha, ms]) => ({ sha, ms, info: commitInfo.get(sha) }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 50);

    if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'loading-cell';
        empty.textContent = 'No commits correlated in this range yet.';
        list.appendChild(empty);
        return;
    }

    for (const r of rows) {
        const row = document.createElement('div');
        row.className = 'commit-row';

        const shaEl = document.createElement('div');
        shaEl.className = 'commit-sha';
        shaEl.textContent = r.sha.slice(0, 7);
        shaEl.title = 'Click to copy full SHA';
        shaEl.addEventListener('click', () => {
            navigator.clipboard?.writeText(r.sha);
        });

        const msgEl = document.createElement('div');
        msgEl.className = 'commit-message';
        msgEl.textContent = r.info?.message || '(no message)';

        const timeEl = document.createElement('div');
        timeEl.className = 'commit-time';
        const min = Math.round(r.ms / 60000);
        timeEl.textContent = min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;

        const deltaEl = document.createElement('div');
        deltaEl.className = 'commit-delta';
        if (r.info) {
            const ins = document.createElement('span'); ins.className = 'ins'; ins.textContent = `+${r.info.insertions || 0}`;
            const del = document.createElement('span'); del.className = 'del'; del.textContent = `-${r.info.deletions || 0}`;
            deltaEl.appendChild(ins); deltaEl.appendChild(del);
        }

        row.appendChild(shaEl); row.appendChild(msgEl); row.appendChild(timeEl); row.appendChild(deltaEl);
        list.appendChild(row);
    }
}
```

In the `case 'updateCommitsForSessions'` handler, after `renderSessionsTable()`, add:

```javascript
renderCommitsCard();
```

- [ ] **Step 4: Compile & commit**

```bash
npm run compile
git add src/ui/WebviewProvider.ts webview/dashboard.js webview/dashboard.css
git commit -m "feat: add time-per-commit aggregation card"
```

---

### Task 8: Validation with real repo

- [ ] **Step 1: Run the extension against this repo**

Reload dev host in the code-pulse project itself. Make a dummy commit (`git commit --allow-empty -m "focus test"`). Start tracking, make another commit, stop tracking.

- [ ] **Step 2: Verify in dashboard**

Commits badge on the session row shows ≥1. The Time-per-Commit card lists the commit.

- [ ] **Step 3: Commit any fix**

If correlation fails, check the logger output (`~/Library/Application Support/Code/logs/.../exthost.log`), add regression test, fix.

---

## Out of scope

- Commit-driven goal tracking.
- Git blame / line-level correlation.
- Multi-repo workspaces with submodules (use workspace root as repo boundary).

## Self-review

Schema migration ✓, git log parsing with stats ✓, non-blocking correlation ✓, sessions table shows commits ✓, time-per-commit aggregation ✓, SHA click-to-copy ✓. Uses `execFile` (safe) not `exec`. Errors logged, never thrown from the tracker path.
