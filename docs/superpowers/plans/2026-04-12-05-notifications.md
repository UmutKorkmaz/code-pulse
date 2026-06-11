# Rich Notifications System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configurable, rate-limited notifications driven by the EventBus introduced in the Focus Mode plan. Rules for break reminders, stretch reminders, long-session warnings, and goal-met celebrations.

**Architecture:** A `NotificationManager` subscribes to `EventBus` events plus its own internal tickers. Each rule has an enable flag in config, a cooldown so it doesn't spam, and a quiet-hours window. Notifications use `vscode.window.showInformationMessage` with action buttons where relevant.

**Depends on:** [Focus Mode plan](2026-04-12-03-focus-mode.md) — the `EventBus` must exist first.

**Tech Stack:** TypeScript. No new deps.

---

## Files

- **Create:** `src/notifications/NotificationManager.ts` — subscriber + dispatcher (~180 lines)
- **Create:** `src/notifications/rules.ts` — pure functions for each rule's decision logic
- **Create:** `test/suite/notifications.test.ts` — rule logic tests
- **Modify:** `package.json` — rule config keys
- **Modify:** `src/extension.ts` — instantiate and wire up
- **Modify:** `src/tracker/TimeTracker.ts` — emit `session-started`, `session-ended`, `long-session` events

---

### Task 1: Config keys

**Files:** Modify `package.json`

- [ ] **Step 1: Add rule config keys**

Under `contributes.configuration.properties`:

```json
"codepulse.notifications.enabled": {
    "type": "boolean",
    "default": true,
    "description": "Master enable for all Code Pulse notifications"
},
"codepulse.notifications.breakReminderMinutes": {
    "type": "number",
    "default": 50,
    "minimum": 0,
    "description": "Show 'take a break' after N continuous minutes of tracking (0 = off)"
},
"codepulse.notifications.longSessionHours": {
    "type": "number",
    "default": 3,
    "minimum": 0,
    "description": "Warn at N hours of continuous tracking (0 = off)"
},
"codepulse.notifications.goalReminder": {
    "type": "boolean",
    "default": true,
    "description": "Notify when daily goal is reached"
},
"codepulse.notifications.quietStart": {
    "type": "string",
    "default": "22:00",
    "pattern": "^\\d{2}:\\d{2}$",
    "description": "Start of quiet hours (HH:MM). No notifications during this window."
},
"codepulse.notifications.quietEnd": {
    "type": "string",
    "default": "07:00",
    "pattern": "^\\d{2}:\\d{2}$",
    "description": "End of quiet hours (HH:MM)"
},
"codepulse.notifications.cooldownMinutes": {
    "type": "number",
    "default": 15,
    "minimum": 1,
    "description": "Minimum minutes between notifications of the same kind"
}
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "feat: add notification rule config keys"
```

---

### Task 2: Pure rule logic with tests

**Files:** Create `src/notifications/rules.ts` + `test/suite/notifications.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/suite/notifications.test.ts`:

```typescript
import * as assert from 'assert';
import { isInQuietHours, shouldFireBreakReminder } from '../../src/notifications/rules';

suite('Notification Rules', () => {
    test('quiet hours across midnight', () => {
        const at = new Date('2026-04-12T23:30:00');
        assert.ok(isInQuietHours(at, '22:00', '07:00'));
    });

    test('quiet hours daytime window excluded', () => {
        const at = new Date('2026-04-12T14:00:00');
        assert.ok(!isInQuietHours(at, '22:00', '07:00'));
    });

    test('quiet hours early morning included', () => {
        const at = new Date('2026-04-12T06:00:00');
        assert.ok(isInQuietHours(at, '22:00', '07:00'));
    });

    test('break reminder fires after threshold', () => {
        const sessionStart = new Date('2026-04-12T09:00:00');
        const now = new Date('2026-04-12T09:55:00'); // 55 min
        const lastFiredAt = undefined;
        assert.ok(shouldFireBreakReminder(sessionStart, now, 50, lastFiredAt, 15));
    });

    test('break reminder respects cooldown', () => {
        const sessionStart = new Date('2026-04-12T09:00:00');
        const now = new Date('2026-04-12T10:05:00'); // 65 min
        const lastFiredAt = new Date('2026-04-12T09:55:00'); // 10 min ago
        assert.ok(!shouldFireBreakReminder(sessionStart, now, 50, lastFiredAt, 15));
    });

    test('break reminder disabled when threshold is 0', () => {
        const sessionStart = new Date('2026-04-12T09:00:00');
        const now = new Date('2026-04-12T12:00:00');
        assert.ok(!shouldFireBreakReminder(sessionStart, now, 0, undefined, 15));
    });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run compile 2>&1 | tail -3`
Expected: TS error — module not found.

- [ ] **Step 3: Implement rules.ts**

```typescript
export function isInQuietHours(at: Date, start: string, end: string): boolean {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const minutes = at.getHours() * 60 + at.getMinutes();
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin === endMin) return false;
    if (startMin < endMin) {
        return minutes >= startMin && minutes < endMin;
    }
    // Wraps midnight
    return minutes >= startMin || minutes < endMin;
}

export function shouldFireBreakReminder(
    sessionStart: Date,
    now: Date,
    thresholdMinutes: number,
    lastFiredAt: Date | undefined,
    cooldownMinutes: number
): boolean {
    if (thresholdMinutes <= 0) return false;
    const sessionMin = (now.getTime() - sessionStart.getTime()) / 60000;
    if (sessionMin < thresholdMinutes) return false;
    if (lastFiredAt) {
        const sinceLast = (now.getTime() - lastFiredAt.getTime()) / 60000;
        if (sinceLast < cooldownMinutes) return false;
    }
    return true;
}

export function shouldFireLongSession(
    sessionStart: Date,
    now: Date,
    thresholdHours: number,
    lastFiredAt: Date | undefined,
    cooldownMinutes: number
): boolean {
    if (thresholdHours <= 0) return false;
    const sessionHr = (now.getTime() - sessionStart.getTime()) / (60 * 60 * 1000);
    if (sessionHr < thresholdHours) return false;
    if (lastFiredAt) {
        const sinceLast = (now.getTime() - lastFiredAt.getTime()) / 60000;
        if (sinceLast < cooldownMinutes) return false;
    }
    return true;
}
```

- [ ] **Step 4: Run tests**

Run: `npm run compile && node ./out/test/runTest.js 2>&1 | grep -E "(passing|failing|Notification)"`
Expected: `6 passing`.

- [ ] **Step 5: Commit**

```bash
git add src/notifications/rules.ts test/suite/notifications.test.ts
git commit -m "feat: add pure notification rule functions"
```

---

### Task 3: NotificationManager class

**Files:** Create `src/notifications/NotificationManager.ts`

- [ ] **Step 1: Implement**

```typescript
import * as vscode from 'vscode';
import { ConfigManager } from '../utils/ConfigManager';
import { Logger } from '../utils/Logger';
import { EventBus, CodePulseEvents } from '../events/EventBus';
import { isInQuietHours, shouldFireBreakReminder, shouldFireLongSession } from './rules';

type RuleKind = 'break' | 'long-session' | 'goal-met';

export class NotificationManager {
    private tickTimer?: NodeJS.Timeout;
    private currentSessionStart?: Date;
    private lastFired: Record<RuleKind, Date | undefined> = {
        break: undefined,
        'long-session': undefined,
        'goal-met': undefined
    };

    constructor(
        private configManager: ConfigManager,
        private logger: Logger,
        private bus: EventBus<CodePulseEvents>
    ) {
        this.bus.on('session-started', ({ sessionId }) => {
            this.currentSessionStart = new Date();
            this.logger.debug(`NotificationManager: tracking session ${sessionId}`);
        });
        this.bus.on('session-ended', () => {
            this.currentSessionStart = undefined;
        });
        this.bus.on('goal-met', ({ hours }) => {
            this.fire('goal-met', `🎉 Daily goal reached — ${hours}h of coding today!`, ['View Dashboard']);
        });
        this.bus.on('focus-break', ({ breakMs }) => {
            const min = Math.round(breakMs / 60000);
            this.fire('break', `☕ Time for a ${min}-minute break.`);
        });

        this.start();
    }

    start(): void {
        if (this.tickTimer) return;
        // Tick every 60s to check time-based rules
        this.tickTimer = setInterval(() => this.tick(), 60_000);
    }

    stop(): void {
        if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = undefined; }
    }

    private tick(): void {
        if (!this.configManager.get<boolean>('notifications.enabled', true)) return;
        if (!this.currentSessionStart) return;

        const now = new Date();
        const quietStart = this.configManager.get<string>('notifications.quietStart', '22:00');
        const quietEnd = this.configManager.get<string>('notifications.quietEnd', '07:00');
        if (isInQuietHours(now, quietStart, quietEnd)) return;

        const cooldown = this.configManager.get<number>('notifications.cooldownMinutes', 15);

        const breakMin = this.configManager.get<number>('notifications.breakReminderMinutes', 50);
        if (shouldFireBreakReminder(this.currentSessionStart, now, breakMin, this.lastFired['break'], cooldown)) {
            this.fire('break', `⏱ You've been coding ${breakMin}+ minutes. Time for a short break?`);
        }

        const longHr = this.configManager.get<number>('notifications.longSessionHours', 3);
        if (shouldFireLongSession(this.currentSessionStart, now, longHr, this.lastFired['long-session'], cooldown)) {
            this.fire('long-session', `⚠️ You've been coding ${longHr}+ hours without a break.`);
        }
    }

    private fire(kind: RuleKind, message: string, actions: string[] = []): void {
        this.lastFired[kind] = new Date();
        this.logger.info(`Notification: ${kind} — ${message}`);
        vscode.window.showInformationMessage(message, ...actions).then(selection => {
            if (selection === 'View Dashboard') {
                vscode.commands.executeCommand('codepulse.showDashboard');
            }
        });
    }
}
```

- [ ] **Step 2: Compile & commit**

```bash
npm run compile
git add src/notifications/NotificationManager.ts
git commit -m "feat: add NotificationManager wiring rules to events"
```

---

### Task 4: Wire NotificationManager into extension.ts

**Files:** Modify `src/extension.ts`

- [ ] **Step 1: Import + declare**

```typescript
import { NotificationManager } from './notifications/NotificationManager';
let notificationManager: NotificationManager;
```

- [ ] **Step 2: Instantiate after focusManager**

```typescript
notificationManager = new NotificationManager(configManager, logger, eventBus);
```

- [ ] **Step 3: Stop on deactivate**

```typescript
if (notificationManager) notificationManager.stop();
```

- [ ] **Step 4: Commit**

```bash
npm run compile
git add src/extension.ts
git commit -m "feat: wire NotificationManager into extension lifecycle"
```

---

### Task 5: Emit session events from TimeTracker

**Files:** Modify `src/tracker/TimeTracker.ts`

- [ ] **Step 1: Accept optional EventBus in constructor**

```typescript
import { EventBus, CodePulseEvents } from '../events/EventBus';

// In class fields
private eventBus?: EventBus<CodePulseEvents>;

// Extend constructor
constructor(
    private context: vscode.ExtensionContext,
    private databaseManager: DatabaseManager,
    private configManager: ConfigManager,
    private logger: Logger,
    eventBus?: EventBus<CodePulseEvents>
) {
    // ...existing body...
    this.eventBus = eventBus;
    // ...
}
```

- [ ] **Step 2: Emit session-started**

Inside `startNewSession`, after `await this.databaseManager.saveSession(this.currentSession);`:

```typescript
this.eventBus?.emit('session-started', { sessionId: this.currentSession.id });
```

- [ ] **Step 3: Emit session-ended**

Inside `endCurrentSession`, right before `this.currentSession = null;`:

```typescript
this.eventBus?.emit('session-ended', {
    sessionId: this.currentSession!.id,
    durationMs: this.currentSession!.duration
});
```

- [ ] **Step 4: Update extension.ts to pass eventBus**

```typescript
timeTracker = new TimeTracker(context, databaseManager, configManager, logger, eventBus);
```

- [ ] **Step 5: Compile & commit**

```bash
npm run compile
git add src/tracker/TimeTracker.ts src/extension.ts
git commit -m "feat: emit session lifecycle events from TimeTracker"
```

---

### Task 6: Emit goal-met event

**Files:** Modify `src/extension.ts`

- [ ] **Step 1: Poll goal status every 5 minutes**

After instantiating notificationManager:

```typescript
const goalPoll = setInterval(async () => {
    try {
        const { GoalsTracker } = await import('./analytics/GoalsTracker');
        const tracker = new GoalsTracker(databaseManager, configManager);
        const status = await tracker.getStatus();
        if (status.todayMet) {
            // Emit once per calendar day using globalState as the dedupe key
            const todayKey = new Date().toISOString().slice(0, 10);
            const lastEmitted = context.globalState.get<string>('codepulse.goalMetEmittedOn');
            if (lastEmitted !== todayKey) {
                await context.globalState.update('codepulse.goalMetEmittedOn', todayKey);
                eventBus.emit('goal-met', { hours: status.dailyHoursGoal });
            }
        }
    } catch (err) {
        logger.warn('goal-met poll failed', err instanceof Error ? err : new Error(String(err)));
    }
}, 5 * 60 * 1000);

context.subscriptions.push({ dispose: () => clearInterval(goalPoll) });
```

- [ ] **Step 2: Compile & commit**

```bash
npm run compile
git add src/extension.ts
git commit -m "feat: emit goal-met event on daily goal reach"
```

---

### Task 7: End-to-end smoke test

- [ ] **Step 1: Temporarily lower thresholds**

In VS Code settings, set:
- `codepulse.notifications.breakReminderMinutes` = `1`
- `codepulse.notifications.cooldownMinutes` = `1`

- [ ] **Step 2: Reload dev host and start tracking**

Wait ~60 seconds. A VS Code notification should appear: "⏱ You've been coding 1+ minutes…".

- [ ] **Step 3: Restore defaults, commit any fix**

Reset the two settings. If any issue, add regression test to `notifications.test.ts`.

---

## Out of scope

- Sound / system-level notifications (VS Code API limit).
- Per-project notification preferences.
- Slack/Discord webhooks.

## Self-review

Spec: break reminder ✓, long-session warning ✓, goal-met celebration ✓, quiet hours ✓, cooldown ✓, config for every rule ✓. Rules are pure and testable separately from VS Code API. Depends only on EventBus from plan #3.
