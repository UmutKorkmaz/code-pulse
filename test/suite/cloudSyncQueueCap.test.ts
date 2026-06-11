import * as assert from 'assert';
import { CloudSync } from '../../src/storage/CloudSync';
import { ActivityEvent } from '../../src/tracker/ActivityDetector';
import { CodingSession } from '../../src/tracker/TimeTracker';
import { ConfigManager } from '../../src/utils/ConfigManager';
import { Logger } from '../../src/utils/Logger';

const MAX_PENDING_SESSIONS = 500;
const MAX_PENDING_ACTIVITIES = 2000;

function createStubConfigManager(): ConfigManager {
    // Defaults only: cloudSync.enabled stays false, so nothing touches the network
    // and every synced item lands in the pending queues.
    return {
        get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
        shouldIncludeFilenamesInCloudSync: () => true
    } as unknown as ConfigManager;
}

function createStubLogger(warnings: string[]): Logger {
    return {
        debug: () => undefined,
        info: () => undefined,
        warn: (message: string) => {
            warnings.push(message);
        },
        error: () => undefined
    } as unknown as Logger;
}

function makeSession(index: number): CodingSession {
    return { id: `session-${index}` } as unknown as CodingSession;
}

function makeActivity(index: number): ActivityEvent {
    return {
        type: 'file_edit',
        timestamp: new Date(index)
    } as unknown as ActivityEvent;
}

suite('CloudSync Queue Cap Test Suite', () => {
    test('Pending sessions are capped at 500 by dropping the oldest', async () => {
        const warnings: string[] = [];
        const cloudSync = new CloudSync(createStubConfigManager(), createStubLogger(warnings));

        for (let i = 0; i < MAX_PENDING_SESSIONS + 5; i++) {
            await cloudSync.syncSession(makeSession(i));
        }

        assert.strictEqual(cloudSync.getSyncStatus().pendingSessions, MAX_PENDING_SESSIONS);

        const pending = (cloudSync as any).pendingSessions as CodingSession[];
        assert.strictEqual(pending[0].id, 'session-5', 'The five oldest sessions must be dropped');
        assert.strictEqual(pending[pending.length - 1].id, `session-${MAX_PENDING_SESSIONS + 4}`);
    });

    test('Pending activities are capped at 2000 by dropping the oldest', async () => {
        const warnings: string[] = [];
        const cloudSync = new CloudSync(createStubConfigManager(), createStubLogger(warnings));

        for (let i = 0; i < MAX_PENDING_ACTIVITIES + 3; i++) {
            await cloudSync.syncActivity(makeActivity(i));
        }

        assert.strictEqual(cloudSync.getSyncStatus().pendingActivities, MAX_PENDING_ACTIVITIES);

        const pending = (cloudSync as any).pendingActivities as ActivityEvent[];
        assert.strictEqual(pending[0].timestamp.getTime(), 3, 'The three oldest activities must be dropped');
        assert.strictEqual(pending[pending.length - 1].timestamp.getTime(), MAX_PENDING_ACTIVITIES + 2);
    });

    test('Overflow logs a single rate-limited warning instead of one per drop', async () => {
        const warnings: string[] = [];
        const cloudSync = new CloudSync(createStubConfigManager(), createStubLogger(warnings));

        for (let i = 0; i < MAX_PENDING_SESSIONS + 50; i++) {
            await cloudSync.syncSession(makeSession(i));
        }

        // Overflow the activity queue too — still inside the rate-limit window.
        for (let i = 0; i < MAX_PENDING_ACTIVITIES + 50; i++) {
            await cloudSync.syncActivity(makeActivity(i));
        }

        const dropWarnings = warnings.filter(message => message.includes('dropped'));
        assert.strictEqual(dropWarnings.length, 1, '100 drops within the window must produce exactly one warning');
        assert.ok(dropWarnings[0].includes('500'), 'Warning should mention the session cap');
        assert.ok(dropWarnings[0].includes('2000'), 'Warning should mention the activity cap');
    });

    test('No warning is logged while the queues stay under their caps', async () => {
        const warnings: string[] = [];
        const cloudSync = new CloudSync(createStubConfigManager(), createStubLogger(warnings));

        for (let i = 0; i < 10; i++) {
            await cloudSync.syncSession(makeSession(i));
            await cloudSync.syncActivity(makeActivity(i));
        }

        assert.strictEqual(cloudSync.getSyncStatus().pendingSessions, 10);
        assert.strictEqual(cloudSync.getSyncStatus().pendingActivities, 10);
        assert.strictEqual(warnings.length, 0);
    });
});
