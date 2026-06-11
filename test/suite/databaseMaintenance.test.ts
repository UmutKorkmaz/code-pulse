import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseManager } from '../../src/storage/DatabaseManager';
import { ActivityEvent } from '../../src/tracker/ActivityDetector';
import { CodingSession, SessionSegment } from '../../src/tracker/TimeTracker';

interface SnapshotFixture {
    sessions: unknown[];
    activities: unknown[];
    segments: unknown[];
    dailyRollups: unknown[];
}

suite('Database Maintenance Test Suite', () => {
    const tempDirs: string[] = [];
    const openDatabases: DatabaseManager[] = [];

    async function createDatabase(): Promise<DatabaseManager> {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepulse-db-test-'));
        tempDirs.push(dir);

        const databaseManager = new DatabaseManager(dir);
        await databaseManager.initialize();
        openDatabases.push(databaseManager);

        return databaseManager;
    }

    suiteTeardown(async () => {
        for (const databaseManager of openDatabases) {
            await databaseManager.close().catch(() => undefined);
        }
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    function buildSessionFixture(): CodingSession {
        return {
            id: 'merge-session-1',
            startTime: new Date('2026-06-01T10:00:00.000Z'),
            endTime: new Date('2026-06-01T11:00:00.000Z'),
            duration: 3600000,
            idleDuration: 60000,
            project: 'code-pulse',
            language: 'typescript',
            file: 'src/extension.ts',
            branch: 'main',
            isActive: false,
            heartbeats: 30,
            keystrokes: 1200,
            linesAdded: 80,
            linesRemoved: 12,
            productivityScore: 77,
            tags: ['deep-work']
        };
    }

    function buildSnapshotFixture(): SnapshotFixture {
        const session = buildSessionFixture();

        const activities: ActivityEvent[] = [
            {
                type: 'file_edit',
                timestamp: new Date('2026-06-01T10:05:00.000Z'),
                sessionId: session.id,
                file: session.file,
                language: session.language,
                project: session.project,
                isIdle: false,
                metadata: { changes: 2 }
            },
            {
                type: 'file_save',
                timestamp: new Date('2026-06-01T10:06:00.000Z'),
                sessionId: session.id,
                file: session.file,
                language: session.language,
                project: session.project,
                isIdle: false
            }
        ];

        const segments: SessionSegment[] = [
            {
                sessionId: session.id,
                segmentType: 'active',
                startTime: new Date('2026-06-01T10:00:00.000Z'),
                endTime: new Date('2026-06-01T10:30:00.000Z'),
                duration: 1800000,
                project: session.project,
                language: session.language,
                file: session.file
            },
            {
                sessionId: session.id,
                segmentType: 'idle',
                startTime: new Date('2026-06-01T10:30:00.000Z'),
                endTime: new Date('2026-06-01T10:31:00.000Z'),
                duration: 60000,
                project: session.project,
                language: session.language,
                file: session.file
            }
        ];

        const dailyRollups = [
            {
                date: '2026-06-01',
                totalTime: 3600000,
                idleTime: 60000,
                sessionCount: 1,
                keystrokes: 1200,
                linesAdded: 80,
                linesRemoved: 12
            }
        ];

        return { sessions: [session], activities, segments, dailyRollups };
    }

    test('WAL journal mode is active after initialize', async () => {
        const databaseManager = await createDatabase();
        const journalMode = await databaseManager.getJournalMode();

        assert.strictEqual(journalMode.toLowerCase(), 'wal');
    });

    test('mergeSnapshot round-trips sessions, activities and segments', async () => {
        const databaseManager = await createDatabase();
        const snapshot = buildSnapshotFixture();

        const inserted = await databaseManager.mergeSnapshot(snapshot);
        assert.strictEqual(inserted, 5, '1 session + 2 activities + 2 segments should be inserted');

        const exported = await databaseManager.exportAllData();
        assert.strictEqual(exported.sessions.length, 1);
        assert.strictEqual(exported.sessions[0].id, 'merge-session-1');
        assert.strictEqual(exported.activities.length, 2);
        assert.deepStrictEqual(
            exported.activities.map(activity => activity.type).sort(),
            ['file_edit', 'file_save']
        );
        assert.deepStrictEqual(exported.activities.find(a => a.type === 'file_edit')?.metadata, { changes: 2 });
        assert.strictEqual(exported.segments.length, 2);
        assert.deepStrictEqual(
            exported.segments.map(segment => segment.segmentType).sort(),
            ['active', 'idle']
        );
        assert.strictEqual(exported.dailyRollups.length, 1);
        assert.strictEqual(exported.dailyRollups[0].totalTime, 3600000);
    });

    test('mergeSnapshot is idempotent for activities and segments', async () => {
        const databaseManager = await createDatabase();
        const snapshot = buildSnapshotFixture();

        const firstMerge = await databaseManager.mergeSnapshot(snapshot);
        assert.strictEqual(firstMerge, 5);

        const secondMerge = await databaseManager.mergeSnapshot(buildSnapshotFixture());
        assert.strictEqual(secondMerge, 0, 'Re-merging the same snapshot must insert nothing');

        const exported = await databaseManager.exportAllData();
        assert.strictEqual(exported.sessions.length, 1);
        assert.strictEqual(exported.activities.length, 2);
        assert.strictEqual(exported.segments.length, 2);
    });

    test('mergeSnapshot skips segments referencing unknown sessions without throwing', async () => {
        const databaseManager = await createDatabase();

        const inserted = await databaseManager.mergeSnapshot({
            sessions: [],
            segments: [
                {
                    sessionId: 'session-that-does-not-exist',
                    segmentType: 'active',
                    startTime: new Date('2026-06-01T10:00:00.000Z'),
                    endTime: new Date('2026-06-01T10:30:00.000Z'),
                    duration: 1800000,
                    project: 'code-pulse',
                    language: 'typescript',
                    file: 'src/extension.ts'
                }
            ]
        });

        assert.strictEqual(inserted, 0, 'Foreign-key orphan segments are skipped, not inserted');

        const exported = await databaseManager.exportAllData();
        assert.strictEqual(exported.segments.length, 0);
    });

    test('saveActivityEvent dedupes byte-identical same-millisecond events', async () => {
        const databaseManager = await createDatabase();
        const event: ActivityEvent = {
            type: 'file_edit',
            timestamp: new Date('2026-06-01T10:05:00.000Z'),
            sessionId: 'live-session-1',
            file: 'src/extension.ts',
            language: 'typescript',
            project: 'code-pulse',
            isIdle: false,
            metadata: { changes: 1 }
        };

        await databaseManager.saveActivityEvent(event);
        await databaseManager.saveActivityEvent(event);

        const exported = await databaseManager.exportAllData();
        assert.strictEqual(exported.activities.length, 1);
    });
});
