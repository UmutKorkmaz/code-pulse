# Goals & Streaks Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users define daily coding-time goals and see current streak, longest streak, and this-week progress on the dashboard.

**Architecture:** A single new `GoalsTracker` class computes streak/progress from the existing `sessions` table. Two config keys define the user goal. One new dashboard card renders the stats. The existing `calculateCodingStreak` in `AnalyticsEngine.ts` uses a binary "any activity" definition — this plan replaces that logic with a goal-aware definition.

**Tech Stack:** TypeScript backend + vanilla JS in `dashboard.js` + CSS.

---

## Files

- **Create:** `src/analytics/GoalsTracker.ts` — new class, ~100 lines
- **Create:** `test/suite/goalsTracker.test.ts` — unit + integration tests
- **Modify:** `package.json` — add 2 config keys
- **Modify:** `src/ui/WebviewProvider.ts` — add `getGoalsStatus` handler + card HTML
- **Modify:** `webview/dashboard.js` — render goals card
- **Modify:** `webview/dashboard.css` — styles for goals card

---

## Core definitions (decided up front)

- **Daily goal met:** session minutes for that local date ≥ `dailyHoursGoal * 60`.
- **Streak:** consecutive days (counting backwards from today) where the goal was met. Today counts even if today isn't over yet, provided the goal is met.
- **Weekly progress:** number of days in the current Mon-Sun week where goal was met, out of 7.
- **Weekly target:** `weeklyDaysGoal` (default 5). Progress ≥ target = "week on track".

---

### Task 1: Add config keys to package.json

**Files:** Modify `package.json`

- [ ] **Step 1: Edit `contributes.configuration.properties`**

In `package.json`, insert these two keys near the existing `codepulse.dataRetentionDays`:

```json
"codepulse.goals.dailyHours": {
    "type": "number",
    "default": 2,
    "minimum": 0.25,
    "maximum": 16,
    "description": "Daily coding time goal in hours (used for streaks and progress)"
},
"codepulse.goals.weeklyDays": {
    "type": "number",
    "default": 5,
    "minimum": 1,
    "maximum": 7,
    "description": "Target days per week to hit the daily goal"
}
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "feat: add goals config keys"
```

---

### Task 2: Create GoalsTracker with streak test

**Files:** Create `src/analytics/GoalsTracker.ts`, create `test/suite/goalsTracker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/suite/goalsTracker.test.ts`:

```typescript
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { GoalsTracker } from '../../src/analytics/GoalsTracker';
import { DatabaseManager } from '../../src/storage/DatabaseManager';
import { ConfigManager } from '../../src/utils/ConfigManager';
import { formatLocalDate } from '../../src/utils/DateUtils';

suite('GoalsTracker', () => {
    let dbm: DatabaseManager;
    let tmpDir: string;

    suiteSetup(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-goals-'));
        dbm = new DatabaseManager(tmpDir);
        await dbm.initialize();
    });

    suiteTeardown(async () => {
        await dbm.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    async function seedDay(daysAgo: number, ms: number) {
        const start = new Date();
        start.setDate(start.getDate() - daysAgo);
        start.setHours(10, 0, 0, 0);
        const end = new Date(start.getTime() + ms);
        await dbm.saveSession({
            id: `t-${daysAgo}`,
            startTime: start,
            endTime: end,
            duration: ms,
            idleDuration: 0,
            project: 'test',
            language: 'typescript',
            file: 'x.ts',
            isActive: false,
            heartbeats: 0,
            keystrokes: 0,
            linesAdded: 0,
            linesRemoved: 0
        });
    }

    test('current streak is 0 when no days met goal', async () => {
        const tracker = new GoalsTracker(dbm, new ConfigManager());
        const status = await tracker.getStatus(2); // 2-hour goal
        assert.strictEqual(status.currentStreak, 0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run compile 2>&1 | tail -3`
Expected: TS error — `GoalsTracker` module does not exist.

- [ ] **Step 3: Create the class with minimal implementation**

Create `src/analytics/GoalsTracker.ts`:

```typescript
import { DatabaseManager } from '../storage/DatabaseManager';
import { ConfigManager } from '../utils/ConfigManager';
import { formatLocalDate, eachLocalDate, startOfLocalDay } from '../utils/DateUtils';

export interface GoalStatus {
    dailyHoursGoal: number;
    weeklyDaysGoal: number;
    todayMs: number;
    todayMet: boolean;
    currentStreak: number;
    longestStreak: number;
    weekProgress: { date: string; met: boolean; ms: number }[];
    weekMetCount: number;
}

export class GoalsTracker {
    constructor(
        private databaseManager: DatabaseManager,
        private configManager: ConfigManager
    ) {}

    public async getStatus(dailyHoursOverride?: number): Promise<GoalStatus> {
        const dailyHoursGoal = dailyHoursOverride ?? this.configManager.get<number>('goals.dailyHours', 2);
        const weeklyDaysGoal = this.configManager.get<number>('goals.weeklyDays', 5);
        const goalMs = dailyHoursGoal * 60 * 60 * 1000;

        // Aggregate last 400 days of sessions to compute streaks + week progress
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - 400);
        const sessions = await this.databaseManager.getSessionsByDateRange(start, end);
        const byDate = new Map<string, number>();
        for (const s of sessions) {
            const key = formatLocalDate(s.startTime);
            byDate.set(key, (byDate.get(key) || 0) + s.duration);
        }

        const todayKey = formatLocalDate(new Date());
        const todayMs = byDate.get(todayKey) || 0;
        const todayMet = todayMs >= goalMs;

        // Current streak — walk backwards from today
        let currentStreak = 0;
        const cursor = startOfLocalDay(new Date());
        for (;;) {
            const key = formatLocalDate(cursor);
            const ms = byDate.get(key) || 0;
            if (ms >= goalMs) {
                currentStreak++;
                cursor.setDate(cursor.getDate() - 1);
            } else {
                // Today-only leniency: if today not met but yesterday was, streak is at
                // least 0 and we stop. If today IS met, we already counted it above.
                break;
            }
        }

        // Longest streak — scan all days in range
        let longestStreak = 0;
        let running = 0;
        for (const dateStr of eachLocalDate(start, end)) {
            const ms = byDate.get(dateStr) || 0;
            if (ms >= goalMs) {
                running++;
                if (running > longestStreak) longestStreak = running;
            } else {
                running = 0;
            }
        }

        // This week (Mon..Sun containing today)
        const today = new Date();
        const dow = today.getDay(); // 0 Sun .. 6 Sat
        const mondayOffset = (dow + 6) % 7; // Mon = 0
        const weekStart = startOfLocalDay(today);
        weekStart.setDate(weekStart.getDate() - mondayOffset);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const weekProgress = eachLocalDate(weekStart, weekEnd).map(dateStr => {
            const ms = byDate.get(dateStr) || 0;
            return { date: dateStr, met: ms >= goalMs, ms };
        });
        const weekMetCount = weekProgress.filter(d => d.met).length;

        return {
            dailyHoursGoal,
            weeklyDaysGoal,
            todayMs,
            todayMet,
            currentStreak,
            longestStreak,
            weekProgress,
            weekMetCount
        };
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run compile && node ./out/test/runTest.js 2>&1 | grep -E "(passing|failing|Goals)"`
Expected: `1 passing` in GoalsTracker.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/GoalsTracker.ts test/suite/goalsTracker.test.ts
git commit -m "feat: add GoalsTracker with status computation"
```

---

### Task 3: Test current streak with sessions

**Files:** Modify `test/suite/goalsTracker.test.ts`

- [ ] **Step 1: Add the test**

Append to the `suite('GoalsTracker', ...)` block:

```typescript
test('current streak counts consecutive met days from today', async () => {
    await seedDay(0, 3 * 60 * 60 * 1000);   // today: 3h
    await seedDay(1, 2.5 * 60 * 60 * 1000); // yesterday: 2.5h
    await seedDay(2, 2.1 * 60 * 60 * 1000); // 2 days ago: 2.1h
    await seedDay(3, 1 * 60 * 60 * 1000);   // 3 days ago: 1h (below 2h goal)

    const tracker = new GoalsTracker(dbm, new ConfigManager());
    const status = await tracker.getStatus(2);
    assert.strictEqual(status.currentStreak, 3);
    assert.ok(status.todayMet);
});
```

- [ ] **Step 2: Run tests**

Run: `npm run compile && node ./out/test/runTest.js 2>&1 | grep -E "(passing|failing|Goals)"`
Expected: `2 passing`.

- [ ] **Step 3: Commit**

```bash
git add test/suite/goalsTracker.test.ts
git commit -m "test: verify current streak across consecutive met days"
```

---

### Task 4: Test longest streak with gap

**Files:** Modify `test/suite/goalsTracker.test.ts`

- [ ] **Step 1: Add the test**

```typescript
test('longest streak spans past consecutive days', async () => {
    // Clean slate for this test — use a fresh dbm
    await dbm.resetAllData();

    // 5-day streak 10-14 days ago
    for (let d = 10; d <= 14; d++) await seedDay(d, 3 * 60 * 60 * 1000);
    // Gap at 15
    // 2-day streak 16-17 days ago
    await seedDay(16, 3 * 60 * 60 * 1000);
    await seedDay(17, 3 * 60 * 60 * 1000);

    const tracker = new GoalsTracker(dbm, new ConfigManager());
    const status = await tracker.getStatus(2);
    assert.strictEqual(status.longestStreak, 5);
});
```

- [ ] **Step 2: Run tests, verify pass**

Run: `npm run compile && node ./out/test/runTest.js 2>&1 | grep -E "(passing|failing|Goals)"`
Expected: `3 passing`.

- [ ] **Step 3: Commit**

```bash
git add test/suite/goalsTracker.test.ts
git commit -m "test: verify longest-streak detection with gap"
```

---

### Task 5: Wire GoalsTracker into WebviewProvider

**Files:** Modify `src/ui/WebviewProvider.ts`

- [ ] **Step 1: Add case `'getGoalsStatus'` to handleWebviewMessage**

```typescript
case 'getGoalsStatus':
    await this.getGoalsStatus(webview);
    break;
```

- [ ] **Step 2: Add the handler method**

```typescript
private async getGoalsStatus(webview?: vscode.Webview) {
    try {
        const { GoalsTracker } = await import('../analytics/GoalsTracker');
        const tracker = new GoalsTracker(this.databaseManager, this.configManager);
        const status = await tracker.getStatus();
        const target = webview ?? this._view?.webview;
        target?.postMessage({ command: 'updateGoalsStatus', data: status });
    } catch (error) {
        console.error('Failed to get goals status:', error);
    }
}
```

- [ ] **Step 3: Verify compile**

Run: `npm run compile 2>&1 | tail -3`
Expected: clean compile.

- [ ] **Step 4: Commit**

```bash
git add src/ui/WebviewProvider.ts
git commit -m "feat: add getGoalsStatus webview handler"
```

---

### Task 6: Add goals card to dashboard HTML

**Files:** Modify `src/ui/WebviewProvider.ts`

- [ ] **Step 1: Insert markup**

Locate `<!-- Stats Card -->` inside `_getFullDashboardHtml`. Insert **below** it (so stats stay on top):

```html
<!-- Goals & Streaks Card -->
<div class="card goals-card">
    <h2 class="card-title">Goals &amp; Streaks</h2>
    <div class="goals-primary">
        <div class="goal-ring">
            <svg id="goalProgressRing" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r="34" class="ring-track"></circle>
                <circle cx="40" cy="40" r="34" class="ring-fill" id="goalRingFill"></circle>
            </svg>
            <div class="goal-ring-label">
                <div class="goal-ring-percent" id="goalRingPercent">0%</div>
                <div class="goal-ring-sub" id="goalRingSub">of today's goal</div>
            </div>
        </div>
        <div class="goals-stats">
            <div class="goal-stat"><div class="stat-value" id="currentStreak">0</div><div class="stat-label">Current streak</div></div>
            <div class="goal-stat"><div class="stat-value" id="longestStreak">0</div><div class="stat-label">Longest</div></div>
            <div class="goal-stat"><div class="stat-value" id="weekProgress">0 / 5</div><div class="stat-label">This week</div></div>
        </div>
    </div>
    <div class="week-strip" id="weekStrip"></div>
</div>
```

- [ ] **Step 2: Set grid span**

Goals card sits next to the Stats card. In dashboard.css (next task), it will span 6 columns. No edit needed here.

- [ ] **Step 3: Commit**

```bash
git add src/ui/WebviewProvider.ts
git commit -m "feat: add goals card markup to dashboard"
```

---

### Task 7: Add goals card CSS

**Files:** Modify `webview/dashboard.css`

- [ ] **Step 1: Append styles**

Add to end of `webview/dashboard.css`:

```css
/* ---------- Goals & Streaks ---------- */
.goals-card { grid-column: span 6; }

.goals-primary {
    display: flex;
    align-items: center;
    gap: 20px;
}

.goal-ring {
    position: relative;
    width: 96px;
    height: 96px;
    flex: 0 0 auto;
}

.goal-ring svg {
    transform: rotate(-90deg);
    width: 100%;
    height: 100%;
}

.ring-track, .ring-fill {
    fill: none;
    stroke-width: 6;
}
.ring-track { stroke: var(--cp-border); }
.ring-fill {
    stroke: var(--cp-green);
    stroke-linecap: round;
    transition: stroke-dashoffset 0.6s ease;
}

.goal-ring-label {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
}
.goal-ring-percent {
    font-size: 20px;
    font-weight: 500;
    color: var(--cp-fg);
    font-variant-numeric: tabular-nums;
    line-height: 1;
}
.goal-ring-sub {
    font-size: 10px;
    color: var(--cp-muted);
    margin-top: 2px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
}

.goals-stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    flex: 1;
}
.goal-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    background: var(--cp-bg-elevated);
    border: 1px solid var(--cp-border);
    border-radius: 4px;
}
.goal-stat .stat-value {
    font-size: 18px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
}
.goal-stat .stat-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--cp-muted);
}

.week-strip {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
    margin-top: 14px;
}
.week-day {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 4px;
    border-radius: 3px;
    font-size: 10px;
    color: var(--cp-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--cp-border);
    background: var(--cp-bg-elevated);
}
.week-day.met { background: color-mix(in srgb, var(--cp-green) 15%, transparent); border-color: color-mix(in srgb, var(--cp-green) 40%, transparent); }
.week-day.today { outline: 1px solid var(--cp-accent); outline-offset: -1px; }
.week-day-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--cp-border);
}
.week-day.met .week-day-dot { background: var(--cp-green); }
```

- [ ] **Step 2: Commit**

```bash
git add webview/dashboard.css
git commit -m "feat: add goals card styles"
```

---

### Task 8: Render goals card in dashboard.js

**Files:** Modify `webview/dashboard.js`

- [ ] **Step 1: Request goals data on init**

In `init()`, add after `requestHeatmap(365);`:

```javascript
requestGoalsStatus();
```

- [ ] **Step 2: Add request + message case**

```javascript
function requestGoalsStatus() {
    vscode.postMessage({ command: 'getGoalsStatus' });
}
```

In `handleMessage` switch:

```javascript
case 'updateGoalsStatus':
    renderGoalsStatus(message.data);
    break;
```

- [ ] **Step 3: Implement renderGoalsStatus**

Append to the IIFE body:

```javascript
function renderGoalsStatus(s) {
    if (!s) return;

    // Progress ring
    const goalMs = s.dailyHoursGoal * 60 * 60 * 1000;
    const pct = Math.min(1, (s.todayMs || 0) / goalMs);
    const circumference = 2 * Math.PI * 34;
    const ring = document.getElementById('goalRingFill');
    if (ring) {
        ring.setAttribute('stroke-dasharray', String(circumference));
        ring.setAttribute('stroke-dashoffset', String(circumference * (1 - pct)));
    }
    const pctEl = document.getElementById('goalRingPercent');
    if (pctEl) pctEl.textContent = `${Math.round(pct * 100)}%`;
    const subEl = document.getElementById('goalRingSub');
    if (subEl) subEl.textContent = `of ${s.dailyHoursGoal}h daily goal`;

    // Stat pills
    const current = document.getElementById('currentStreak');
    if (current) current.textContent = `${s.currentStreak}d`;
    const longest = document.getElementById('longestStreak');
    if (longest) longest.textContent = `${s.longestStreak}d`;
    const week = document.getElementById('weekProgress');
    if (week) week.textContent = `${s.weekMetCount} / ${s.weeklyDaysGoal}`;

    // Week strip
    const strip = document.getElementById('weekStrip');
    if (strip) {
        while (strip.firstChild) strip.removeChild(strip.firstChild);
        const todayKey = new Date().toISOString().slice(0, 10);
        const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        (s.weekProgress || []).forEach((d, i) => {
            const day = document.createElement('div');
            day.className = 'week-day' + (d.met ? ' met' : '') + (d.date === todayKey ? ' today' : '');
            const dot = document.createElement('div');
            dot.className = 'week-day-dot';
            const label = document.createElement('div');
            label.textContent = labels[i];
            day.appendChild(dot);
            day.appendChild(label);
            strip.appendChild(day);
        });
    }
}
```

- [ ] **Step 4: Compile + smoke**

Run: `npm run compile 2>&1 | tail -3`
Expected: clean compile.

Reload dev host → dashboard → Goals card appears. Seed data means today's progress depends on today's seed — this may be 0% if today's generator produced 0 sessions. That's fine for now.

- [ ] **Step 5: Commit**

```bash
git add webview/dashboard.js
git commit -m "feat: render goals and streaks card"
```

---

### Task 9: Refresh goals on tracking toggle

**Files:** Modify `src/ui/WebviewProvider.ts`

- [ ] **Step 1: Extend the `refresh()` method**

Find the existing `refresh()` method. After `await this.broadcastToDashboards();`, add a broadcast for goals:

```typescript
await this.broadcastGoalsToDashboards();
```

Then add the helper near `broadcastToDashboards`:

```typescript
private async broadcastGoalsToDashboards(): Promise<void> {
    for (const panel of this._dashboardPanels) {
        await this.getGoalsStatus(panel.webview);
    }
    if (this._view) {
        // Sidebar doesn't render goals card currently; safe no-op.
    }
}
```

- [ ] **Step 2: Verify compile**

Run: `npm run compile 2>&1 | tail -3`
Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/ui/WebviewProvider.ts
git commit -m "feat: refresh goals card on tracking toggle"
```

---

### Task 10: Integration verification

- [ ] **Step 1: Re-seed if needed**

`node scripts/seed-data.js --reset`

- [ ] **Step 2: Confirm UI**

Reload dev host, open dashboard:

1. Goals card shows a green ring (part or full) reflecting today's progress.
2. Current streak / Longest streak / This week stats populate.
3. Week strip has 7 day pills; met days are green-tinted; today has outline.
4. Change `codepulse.goals.dailyHours` in settings to `10` → dashboard updates on refresh → streak numbers drop dramatically.
5. Change back to `2` → numbers return.

- [ ] **Step 3: Commit any fix**

If #4 doesn't update on settings change, extend `synchronizeRuntimeConfiguration` in `extension.ts` to also call `webviewProvider.refresh()`. Confirm it already does (it should, from a previous session). If yes, no-op.

---

## Out of scope

- Streak break notifications (Notifications plan).
- "Share my streak" export.
- Per-project goals (future).

## Self-review

Spec covers: daily-goal ring ✓, current streak ✓, longest streak ✓, weekly progress ✓, week strip ✓. Types (`GoalStatus`) defined once and used in both backend and webview. No placeholders. All user strings pass through textContent (DOM-safe).
