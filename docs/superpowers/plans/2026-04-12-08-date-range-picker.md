# Custom Date Range Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the preset-only date dropdown on the dashboard Sessions Table with a true date range picker (two date inputs), plus a "Compare to previous period" toggle that highlights deltas vs. the same-length window immediately before.

**Architecture:** Two `<input type="date">` elements drive a custom `{ from, to }` filter. Presets (Last 7/30/90 days, This month, Last month, All time, Custom) live in a dropdown that sets the dates. A comparison summary appears when the toggle is on — showing % change in total hours and session count vs. the previous period.

**Tech Stack:** Vanilla HTML date inputs + small TS helper in `AnalyticsEngine` for comparison math.

---

## Files

- **Modify:** `src/ui/WebviewProvider.ts` — replace the dropdown with a new filters group + handler for custom range
- **Modify:** `webview/dashboard.js` — new state fields, preset logic, comparison rendering
- **Modify:** `webview/dashboard.css` — date-picker styles + comparison pill
- **Modify:** `src/analytics/AnalyticsEngine.ts` — add `compareRanges(curStart, curEnd, prevStart, prevEnd)`
- **Create:** `test/suite/compareRanges.test.ts`

---

### Task 1: AnalyticsEngine.compareRanges helper + tests

**Files:** Modify `src/analytics/AnalyticsEngine.ts`, create test

- [ ] **Step 1: Write failing tests**

Create `test/suite/compareRanges.test.ts`:

```typescript
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AnalyticsEngine } from '../../src/analytics/AnalyticsEngine';
import { DatabaseManager } from '../../src/storage/DatabaseManager';
import { ConfigManager } from '../../src/utils/ConfigManager';

suite('AnalyticsEngine.compareRanges', () => {
    let dbm: DatabaseManager;
    let engine: AnalyticsEngine;
    let tmpDir: string;

    suiteSetup(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cmp-'));
        dbm = new DatabaseManager(tmpDir);
        await dbm.initialize();
        engine = new AnalyticsEngine(dbm, new ConfigManager());
    });

    suiteTeardown(async () => {
        await dbm.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    async function seed(isoStart: string, durationMs: number) {
        const start = new Date(isoStart);
        const end = new Date(start.getTime() + durationMs);
        await dbm.saveSession({
            id: `s-${isoStart}`, startTime: start, endTime: end,
            duration: durationMs, idleDuration: 0,
            project: 'p', language: 'ts', file: 'x',
            isActive: false, heartbeats: 0, keystrokes: 0, linesAdded: 0, linesRemoved: 0
        });
    }

    test('zero when both ranges empty', async () => {
        const res = await engine.compareRanges(
            new Date('2026-01-01'), new Date('2026-01-07'),
            new Date('2025-12-25'), new Date('2025-12-31')
        );
        assert.strictEqual(res.current.totalMs, 0);
        assert.strictEqual(res.previous.totalMs, 0);
        assert.strictEqual(res.deltaPct, 0);
    });

    test('returns 100% delta when previous empty', async () => {
        await seed('2026-01-03T10:00:00Z', 60 * 60 * 1000);
        const res = await engine.compareRanges(
            new Date('2026-01-01T00:00:00Z'), new Date('2026-01-07T23:59:59Z'),
            new Date('2025-12-25'), new Date('2025-12-31T23:59:59Z')
        );
        assert.strictEqual(res.current.sessionCount, 1);
        assert.strictEqual(res.deltaPct, Infinity);
    });
});
```

- [ ] **Step 2: Compile, verify fail**

Run: `npm run compile 2>&1 | tail -3`
Expected: TS error — compareRanges not found.

- [ ] **Step 3: Implement compareRanges**

Add to `src/analytics/AnalyticsEngine.ts` near other public methods:

```typescript
public async compareRanges(
    curStart: Date, curEnd: Date,
    prevStart: Date, prevEnd: Date
): Promise<{
    current: { totalMs: number; sessionCount: number };
    previous: { totalMs: number; sessionCount: number };
    deltaPct: number;
    sessionDeltaPct: number;
}> {
    const [cur, prev] = await Promise.all([
        this.databaseManager.getSessionsByDateRange(curStart, curEnd),
        this.databaseManager.getSessionsByDateRange(prevStart, prevEnd)
    ]);
    const curTotal = cur.reduce((s, x) => s + x.duration, 0);
    const prevTotal = prev.reduce((s, x) => s + x.duration, 0);
    const deltaPct = prevTotal === 0
        ? (curTotal > 0 ? Infinity : 0)
        : ((curTotal - prevTotal) / prevTotal) * 100;
    const sessionDeltaPct = prev.length === 0
        ? (cur.length > 0 ? Infinity : 0)
        : ((cur.length - prev.length) / prev.length) * 100;

    return {
        current:  { totalMs: curTotal,  sessionCount: cur.length  },
        previous: { totalMs: prevTotal, sessionCount: prev.length },
        deltaPct, sessionDeltaPct
    };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run compile && node ./out/test/runTest.js 2>&1 | grep -E "(passing|failing|compareRanges)"`
Expected: `2 passing`.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/AnalyticsEngine.ts test/suite/compareRanges.test.ts
git commit -m "feat: add compareRanges helper for period comparison"
```

---

### Task 2: Replace the dropdown with date inputs + preset chips

**Files:** Modify `src/ui/WebviewProvider.ts`

- [ ] **Step 1: Replace the existing `#sessionDateRange` `<select>` with richer controls**

In `_getFullDashboardHtml`, inside `.sessions-filters`, find the existing `<select id="sessionDateRange">…</select>` block and replace it with:

```html
<div class="daterange-group">
    <select id="sessionDateRangePreset" class="filter-input">
        <option value="7">Last 7 days</option>
        <option value="30" selected>Last 30 days</option>
        <option value="90">Last 90 days</option>
        <option value="365">Last year</option>
        <option value="thisMonth">This month</option>
        <option value="lastMonth">Last month</option>
        <option value="all">All time</option>
        <option value="custom">Custom…</option>
    </select>
    <input type="date" id="sessionDateFrom" class="filter-input daterange-input" />
    <span class="daterange-sep">→</span>
    <input type="date" id="sessionDateTo" class="filter-input daterange-input" />
    <label class="compare-toggle">
        <input type="checkbox" id="sessionCompareToggle" />
        <span>Compare vs. prev</span>
    </label>
</div>
<div class="compare-summary" id="sessionCompareSummary" hidden></div>
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/WebviewProvider.ts
git commit -m "feat: add date-range picker markup to sessions filters"
```

---

### Task 3: CSS for date picker + compare pill

**Files:** Modify `webview/dashboard.css`

- [ ] **Step 1: Append**

```css
/* ---------- Date Range Picker ---------- */
.daterange-group {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
}
.daterange-input { min-width: 130px; }
.daterange-sep {
    color: var(--cp-muted);
    font-size: 12px;
}
.compare-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--cp-muted);
    cursor: pointer;
    user-select: none;
}
.compare-toggle input { margin: 0; }

.compare-summary {
    display: flex;
    gap: 12px;
    margin-top: 8px;
    padding: 6px 10px;
    font-size: 11px;
    border-radius: 3px;
    background: var(--cp-bg-elevated);
    border: 1px solid var(--cp-border);
    color: var(--cp-muted);
    align-items: center;
}
.compare-summary .delta {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
}
.compare-summary .delta.up   { color: var(--cp-green); }
.compare-summary .delta.down { color: var(--cp-red); }
.compare-summary .delta.flat { color: var(--cp-muted); }
```

- [ ] **Step 2: Commit**

```bash
git add webview/dashboard.css
git commit -m "feat: add date-range picker + compare summary styles"
```

---

### Task 4: Wire preset logic, custom range, and comparison

**Files:** Modify `webview/dashboard.js`

- [ ] **Step 1: Replace the existing preset handler**

Remove the old event listener on `#sessionDateRange` (inside `setupSessionsTable`). Replace with the new preset + date-input handlers:

```javascript
function computePresetRange(preset) {
    const today = new Date();
    const toStr = today.toISOString().slice(0, 10);
    const fromD = new Date(today);

    if (preset === '7') fromD.setDate(fromD.getDate() - 6);
    else if (preset === '30') fromD.setDate(fromD.getDate() - 29);
    else if (preset === '90') fromD.setDate(fromD.getDate() - 89);
    else if (preset === '365') fromD.setDate(fromD.getDate() - 364);
    else if (preset === 'thisMonth') fromD.setDate(1);
    else if (preset === 'lastMonth') {
        fromD.setMonth(fromD.getMonth() - 1);
        fromD.setDate(1);
        const endOfLast = new Date(today.getFullYear(), today.getMonth(), 0);
        return { from: fromD.toISOString().slice(0,10), to: endOfLast.toISOString().slice(0,10) };
    }
    else if (preset === 'all') fromD.setFullYear(2000);
    else return null;

    return { from: fromD.toISOString().slice(0,10), to: toStr };
}

function setDateRange(from, to) {
    const fromInput = document.getElementById('sessionDateFrom');
    const toInput   = document.getElementById('sessionDateTo');
    if (fromInput) fromInput.value = from;
    if (toInput)   toInput.value   = to;
}

function currentRange() {
    const f = document.getElementById('sessionDateFrom')?.value;
    const t = document.getElementById('sessionDateTo')?.value;
    return { from: f, to: t };
}

function fetchSessionsForRange() {
    const { from, to } = currentRange();
    if (!from || !to) return;
    vscode.postMessage({ command: 'getAllSessions', from, to });

    if (document.getElementById('sessionCompareToggle')?.checked) {
        vscode.postMessage({ command: 'getRangeComparison', from, to });
    } else {
        const sum = document.getElementById('sessionCompareSummary');
        if (sum) sum.hidden = true;
    }
}

const presetSel = document.getElementById('sessionDateRangePreset');
if (presetSel) presetSel.addEventListener('change', e => {
    const val = e.target.value;
    if (val === 'custom') return; // user types dates
    const r = computePresetRange(val);
    if (r) { setDateRange(r.from, r.to); fetchSessionsForRange(); }
});

['sessionDateFrom', 'sessionDateTo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
        document.getElementById('sessionDateRangePreset').value = 'custom';
        fetchSessionsForRange();
    });
});

const cmp = document.getElementById('sessionCompareToggle');
if (cmp) cmp.addEventListener('change', fetchSessionsForRange);

// Init to "Last 30 days"
const initRange = computePresetRange('30');
if (initRange) setDateRange(initRange.from, initRange.to);
```

- [ ] **Step 2: Handle server response for comparison**

Add case to `handleMessage`:

```javascript
case 'updateRangeComparison':
    renderCompareSummary(message.data);
    break;
```

Render function:

```javascript
function renderCompareSummary(res) {
    const sum = document.getElementById('sessionCompareSummary');
    if (!sum || !res) return;
    sum.hidden = false;
    while (sum.firstChild) sum.removeChild(sum.firstChild);

    const addDelta = (label, pct) => {
        const wrap = document.createElement('span');
        wrap.className = 'delta ' + (pct === 0 ? 'flat' : pct > 0 ? 'up' : 'down');
        const arrow = pct === 0 ? '→' : pct > 0 ? '▲' : '▼';
        let text = '∞';
        if (pct !== Infinity && pct !== -Infinity && isFinite(pct)) text = `${Math.abs(pct).toFixed(1)}%`;
        wrap.textContent = `${label}: ${arrow} ${text}`;
        sum.appendChild(wrap);
    };

    const curHours = (res.current.totalMs / 3600000).toFixed(1);
    const prevHours = (res.previous.totalMs / 3600000).toFixed(1);
    const header = document.createElement('span');
    header.textContent = `Current ${curHours}h · Previous ${prevHours}h`;
    sum.appendChild(header);

    addDelta('Time',     res.deltaPct);
    addDelta('Sessions', res.sessionDeltaPct);
}
```

- [ ] **Step 3: Update `getAllSessions` backend to accept from/to**

In `src/ui/WebviewProvider.ts`, find the existing `getAllSessions(days: number, webview?)` handler. Extend it to accept explicit dates:

```typescript
case 'getAllSessions':
    if (message.from && message.to) {
        await this.getAllSessionsRange(new Date(message.from), new Date(message.to), webview);
    } else {
        await this.getAllSessions(message.days ?? 0, webview);
    }
    break;

case 'getRangeComparison':
    await this.getRangeComparison(new Date(message.from), new Date(message.to), webview);
    break;
```

Add:

```typescript
private async getAllSessionsRange(from: Date, to: Date, webview?: vscode.Webview) {
    const end = new Date(to); end.setHours(23, 59, 59, 999);
    const start = new Date(from); start.setHours(0, 0, 0, 0);
    const sessions = await this.databaseManager.getSessionsByDateRange(start, end);
    const target = webview ?? this._view?.webview;
    target?.postMessage({ command: 'updateAllSessions', data: { sessions, from, to } });
}

private async getRangeComparison(from: Date, to: Date, webview?: vscode.Webview) {
    const start = new Date(from); start.setHours(0, 0, 0, 0);
    const end   = new Date(to);   end.setHours(23, 59, 59, 999);
    const rangeMs = end.getTime() - start.getTime();
    const prevEnd   = new Date(start.getTime() - 1);
    const prevStart = new Date(prevEnd.getTime() - rangeMs);

    const { AnalyticsEngine } = await import('../analytics/AnalyticsEngine');
    const engine = new AnalyticsEngine(this.databaseManager, this.configManager);
    const res = await engine.compareRanges(start, end, prevStart, prevEnd);
    const target = webview ?? this._view?.webview;
    target?.postMessage({ command: 'updateRangeComparison', data: res });
}
```

- [ ] **Step 4: Compile & commit**

```bash
npm run compile
git add src/ui/WebviewProvider.ts webview/dashboard.js
git commit -m "feat: custom date range + period comparison for sessions table"
```

---

### Task 5: End-to-end validation

- [ ] **Step 1: Reload dev host, open dashboard**

Pick **Last 30 days** → sessions load. Pick **Custom…** → change dates → sessions reload.

- [ ] **Step 2: Enable Compare toggle**

Checkbox at the right of the date inputs. Summary pill appears with current vs previous totals and arrows.

- [ ] **Step 3: Try "This month" and "Last month"**

Verify both fetch the right windows.

- [ ] **Step 4: Commit any fix**

---

## Out of scope

- Comparing specific named periods (Q1 vs Q2, etc.).
- Saving a user's favorite custom ranges.
- Date picker dropdown with calendar popover (native inputs are good enough for now).

## Self-review

Spec: date range picker ✓, presets including This/Last month ✓, comparison vs previous period ✓, summary pill ✓. Pure `compareRanges` tested. Backend accepts either `days` (legacy) or `from/to` (new) for backward compatibility with any other callers.
