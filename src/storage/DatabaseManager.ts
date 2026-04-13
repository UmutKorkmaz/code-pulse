import * as fs from 'fs';
import * as path from 'path';
import * as sqlite3 from 'sqlite3';
import { ActivityEvent } from '../tracker/ActivityDetector';
import { CodingSession, SessionSegment } from '../tracker/TimeTracker';
import { getLocalDateBounds } from '../utils/DateUtils';

export interface DatabaseSession extends CodingSession {
    created_at?: string;
    updated_at?: string;
}

export interface DatabaseActivity extends ActivityEvent {
    id?: number;
    created_at?: string;
}

export interface DailyRollup {
    date: string;
    totalTime: number;
    idleTime: number;
    sessionCount: number;
    keystrokes: number;
    linesAdded: number;
    linesRemoved: number;
    updatedAt?: string;
}

export class DatabaseManager {
    private static readonly SCHEMA_VERSION = 3;

    private db: sqlite3.Database | null = null;
    private dbPath: string;

    constructor(storagePath: string) {
        this.dbPath = path.join(storagePath, 'codepulse.db');
    }

    public async initialize(): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true });

        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, async err => {
                if (err) {
                    reject(new Error(`Failed to open database: ${err.message}`));
                    return;
                }

                try {
                    await this.run('PRAGMA foreign_keys = ON');
                    await this.run('PRAGMA busy_timeout = 5000');
                    await this.migrateSchema();
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    public async close(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                resolve();
                return;
            }

            this.db.close(err => {
                if (err) {
                    reject(new Error(`Failed to close database: ${err.message}`));
                } else {
                    this.db = null;
                    resolve();
                }
            });
        });
    }

    public async saveSession(session: CodingSession): Promise<void> {
        await this.run(
            `
                INSERT INTO sessions (
                    id, start_time, end_time, duration, idle_duration, project, language, file, branch,
                    is_active, heartbeats, keystrokes, lines_added, lines_removed, productivity_score
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                session.id,
                session.startTime.toISOString(),
                session.endTime?.toISOString() || null,
                session.duration,
                session.idleDuration,
                session.project,
                session.language,
                session.file,
                session.branch || null,
                session.isActive ? 1 : 0,
                session.heartbeats,
                session.keystrokes,
                session.linesAdded,
                session.linesRemoved,
                session.productivityScore || null
            ]
        );
    }

    public async updateSession(session: CodingSession): Promise<void> {
        await this.run(
            `
                UPDATE sessions SET
                    end_time = ?,
                    duration = ?,
                    idle_duration = ?,
                    is_active = ?,
                    heartbeats = ?,
                    keystrokes = ?,
                    lines_added = ?,
                    lines_removed = ?,
                    productivity_score = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `,
            [
                session.endTime?.toISOString() || null,
                session.duration,
                session.idleDuration,
                session.isActive ? 1 : 0,
                session.heartbeats,
                session.keystrokes,
                session.linesAdded,
                session.linesRemoved,
                session.productivityScore || null,
                session.id
            ]
        );
    }

    public async getSession(sessionId: string): Promise<DatabaseSession | null> {
        const row = await this.get<any>('SELECT * FROM sessions WHERE id = ?', [sessionId]);
        return row ? this.mapRowToSession(row) : null;
    }

    public async getSessionsByDateRange(startDate: Date, endDate: Date): Promise<DatabaseSession[]> {
        const rows = await this.all<any>(
            `
                SELECT * FROM sessions
                WHERE start_time >= ? AND start_time < ?
                ORDER BY start_time ASC
            `,
            [startDate.toISOString(), endDate.toISOString()]
        );

        return rows.map(row => this.mapRowToSession(row));
    }

    public async getSessionsByDate(date: string): Promise<DatabaseSession[]> {
        const bounds = getLocalDateBounds(date);
        return this.getSessionsByDateRange(bounds.start, bounds.end);
    }

    public async saveActivityEvent(event: ActivityEvent): Promise<void> {
        await this.run(
            `
                INSERT INTO activities (type, timestamp, session_id, file, language, project, is_idle, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                event.type,
                event.timestamp.toISOString(),
                event.sessionId || null,
                event.file || null,
                event.language || null,
                event.project || null,
                event.isIdle ? 1 : 0,
                event.metadata ? JSON.stringify(event.metadata) : null
            ]
        );
    }

    public async getActivitiesByDateRange(startDate: Date, endDate: Date): Promise<ActivityEvent[]> {
        const rows = await this.all<any>(
            `
                SELECT * FROM activities
                WHERE timestamp >= ? AND timestamp < ?
                ORDER BY timestamp ASC
            `,
            [startDate.toISOString(), endDate.toISOString()]
        );

        return rows.map(row => this.mapRowToActivity(row));
    }

    public async saveSessionSegment(segment: SessionSegment): Promise<number> {
        const result = await this.run(
            `
                INSERT INTO session_segments (
                    session_id, segment_type, start_time, end_time, duration, project, language, file
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                segment.sessionId,
                segment.segmentType,
                segment.startTime.toISOString(),
                segment.endTime?.toISOString() || null,
                segment.duration,
                segment.project,
                segment.language,
                segment.file
            ]
        );

        return result.lastID;
    }

    public async updateSessionSegment(segment: SessionSegment): Promise<void> {
        if (!segment.id) {
            return;
        }

        await this.run(
            `
                UPDATE session_segments SET
                    end_time = ?,
                    duration = ?,
                    project = ?,
                    language = ?,
                    file = ?
                WHERE id = ?
            `,
            [
                segment.endTime?.toISOString() || null,
                segment.duration,
                segment.project,
                segment.language,
                segment.file,
                segment.id
            ]
        );
    }

    public async getTotalTimeByProject(startDate: Date, endDate: Date): Promise<{ [project: string]: number }> {
        const rows = await this.all<any>(
            `
                SELECT project, SUM(duration) as total_duration
                FROM sessions
                WHERE start_time >= ? AND start_time < ?
                GROUP BY project
                ORDER BY total_duration DESC
            `,
            [startDate.toISOString(), endDate.toISOString()]
        );

        const result: { [project: string]: number } = {};
        rows.forEach(row => {
            result[row.project] = row.total_duration;
        });
        return result;
    }

    public async getTotalTimeByLanguage(startDate: Date, endDate: Date): Promise<{ [language: string]: number }> {
        const rows = await this.all<any>(
            `
                SELECT language, SUM(duration) as total_duration
                FROM sessions
                WHERE start_time >= ? AND start_time < ?
                GROUP BY language
                ORDER BY total_duration DESC
            `,
            [startDate.toISOString(), endDate.toISOString()]
        );

        const result: { [language: string]: number } = {};
        rows.forEach(row => {
            result[row.language] = row.total_duration;
        });
        return result;
    }

    public async getTotalTimeByFile(startDate: Date, endDate: Date): Promise<{ [file: string]: number }> {
        const rows = await this.all<any>(
            `
                SELECT file, SUM(duration) as total_duration
                FROM sessions
                WHERE start_time >= ? AND start_time < ?
                GROUP BY file
                ORDER BY total_duration DESC
                LIMIT 50
            `,
            [startDate.toISOString(), endDate.toISOString()]
        );

        const result: { [file: string]: number } = {};
        rows.forEach(row => {
            result[row.file] = row.total_duration;
        });
        return result;
    }

    public async incrementDailyRollup(date: string, session: CodingSession): Promise<void> {
        await this.run(
            `
                INSERT INTO daily_rollups (
                    date, total_time, idle_time, session_count, keystrokes, lines_added, lines_removed, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(date) DO UPDATE SET
                    total_time = total_time + excluded.total_time,
                    idle_time = idle_time + excluded.idle_time,
                    session_count = session_count + excluded.session_count,
                    keystrokes = keystrokes + excluded.keystrokes,
                    lines_added = lines_added + excluded.lines_added,
                    lines_removed = lines_removed + excluded.lines_removed,
                    updated_at = CURRENT_TIMESTAMP
            `,
            [
                date,
                session.duration,
                session.idleDuration,
                1,
                session.keystrokes,
                session.linesAdded,
                session.linesRemoved
            ]
        );
    }

    public async exportAllData(): Promise<{
        export_date: string;
        schema_version: number;
        sessions: DatabaseSession[];
        activities: ActivityEvent[];
        segments: SessionSegment[];
        dailyRollups: DailyRollup[];
        version: string;
    }> {
        const [sessions, activities, segments, dailyRollups] = await Promise.all([
            this.getAllSessions(),
            this.getAllActivities(),
            this.getAllSegments(),
            this.getAllDailyRollups()
        ]);

        return {
            export_date: new Date().toISOString(),
            schema_version: DatabaseManager.SCHEMA_VERSION,
            sessions,
            activities,
            segments,
            dailyRollups,
            version: '1.0.0'
        };
    }

    /**
     * Merge a snapshot from another device into this database.
     * Uses INSERT OR IGNORE on session ID to skip records we already have.
     * Returns the number of new records inserted.
     */
    public async mergeSnapshot(snapshot: {
        sessions: unknown[];
        activities?: unknown[];
        segments?: unknown[];
        dailyRollups?: unknown[];
    }): Promise<number> {
        let inserted = 0;

        for (const raw of snapshot.sessions || []) {
            const s = raw as DatabaseSession;
            const res = await this.run(
                `INSERT OR IGNORE INTO sessions (
                    id, start_time, end_time, duration, idle_duration, project, language, file, branch,
                    is_active, heartbeats, keystrokes, lines_added, lines_removed, productivity_score
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    s.id,
                    new Date(s.startTime).toISOString(),
                    s.endTime ? new Date(s.endTime).toISOString() : null,
                    s.duration || 0,
                    s.idleDuration || 0,
                    s.project,
                    s.language,
                    s.file,
                    s.branch || null,
                    s.isActive ? 1 : 0,
                    s.heartbeats || 0,
                    s.keystrokes || 0,
                    s.linesAdded || 0,
                    s.linesRemoved || 0,
                    s.productivityScore ?? null
                ]
            );
            inserted += res.changes;
        }

        for (const raw of snapshot.dailyRollups || []) {
            const r = raw as DailyRollup;
            await this.run(
                `INSERT INTO daily_rollups (date, total_time, idle_time, session_count, keystrokes, lines_added, lines_removed, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(date) DO UPDATE SET
                    total_time = MAX(total_time, excluded.total_time),
                    idle_time = MAX(idle_time, excluded.idle_time),
                    session_count = MAX(session_count, excluded.session_count),
                    keystrokes = MAX(keystrokes, excluded.keystrokes),
                    lines_added = MAX(lines_added, excluded.lines_added),
                    lines_removed = MAX(lines_removed, excluded.lines_removed),
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    r.date,
                    r.totalTime || 0,
                    r.idleTime || 0,
                    r.sessionCount || 0,
                    r.keystrokes || 0,
                    r.linesAdded || 0,
                    r.linesRemoved || 0
                ]
            );
        }

        return inserted;
    }

    public async pruneOldData(retentionDays: number): Promise<number> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        const cutoffISO = cutoffDate.toISOString();

        const segmentResult = await this.run('DELETE FROM session_segments WHERE start_time < ?', [cutoffISO]);
        const activityResult = await this.run('DELETE FROM activities WHERE timestamp < ?', [cutoffISO]);
        const sessionResult = await this.run('DELETE FROM sessions WHERE start_time < ? AND is_active = 0', [
            cutoffISO
        ]);
        const rollupResult = await this.run('DELETE FROM daily_rollups WHERE date < ?', [
            cutoffDate.toISOString().split('T')[0]
        ]);

        return segmentResult.changes + activityResult.changes + sessionResult.changes + rollupResult.changes;
    }

    public async resetAllData(): Promise<void> {
        await this.run('DELETE FROM session_segments');
        await this.run('DELETE FROM daily_rollups');
        await this.run('DELETE FROM activities');
        await this.run('DELETE FROM sessions');
    }

    private async migrateSchema(): Promise<void> {
        await this.run(
            `
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            `
        );

        await this.run(
            `
                INSERT OR IGNORE INTO meta (key, value)
                VALUES ('schema_version', '0')
            `
        );

        let currentVersion = Number(
            (await this.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`))?.value || '0'
        );

        if (currentVersion < 1) {
            await this.migrateToV1();
            currentVersion = 1;
            await this.setSchemaVersion(currentVersion);
        }

        if (currentVersion < 2) {
            await this.migrateToV2();
            currentVersion = 2;
            await this.setSchemaVersion(currentVersion);
        }

        if (currentVersion < 3) {
            await this.migrateToV3();
            currentVersion = 3;
            await this.setSchemaVersion(currentVersion);
        }
    }

    private async migrateToV1(): Promise<void> {
        await this.run(
            `
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    start_time TEXT NOT NULL,
                    end_time TEXT,
                    duration INTEGER DEFAULT 0,
                    project TEXT NOT NULL,
                    language TEXT NOT NULL,
                    file TEXT NOT NULL,
                    branch TEXT,
                    is_active INTEGER DEFAULT 1,
                    heartbeats INTEGER DEFAULT 0,
                    keystrokes INTEGER DEFAULT 0,
                    lines_added INTEGER DEFAULT 0,
                    lines_removed INTEGER DEFAULT 0,
                    productivity_score REAL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `
        );

        await this.run(
            `
                CREATE TABLE IF NOT EXISTS activities (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    file TEXT,
                    language TEXT,
                    project TEXT,
                    metadata TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `
        );

        await this.createBaseIndexes();
    }

    private async migrateToV2(): Promise<void> {
        await this.addColumnIfMissing('sessions', 'idle_duration', 'INTEGER DEFAULT 0');
        await this.addColumnIfMissing('activities', 'session_id', 'TEXT');
        await this.addColumnIfMissing('activities', 'is_idle', 'INTEGER DEFAULT 0');
        await this.run('UPDATE sessions SET idle_duration = 0 WHERE idle_duration IS NULL');
        await this.run('CREATE INDEX IF NOT EXISTS idx_activities_session_id ON activities(session_id)');
    }

    private async migrateToV3(): Promise<void> {
        await this.run(
            `
                CREATE TABLE IF NOT EXISTS session_segments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    segment_type TEXT NOT NULL,
                    start_time TEXT NOT NULL,
                    end_time TEXT,
                    duration INTEGER DEFAULT 0,
                    project TEXT NOT NULL,
                    language TEXT NOT NULL,
                    file TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
                )
            `
        );

        await this.run(
            `
                CREATE TABLE IF NOT EXISTS daily_rollups (
                    date TEXT PRIMARY KEY,
                    total_time INTEGER DEFAULT 0,
                    idle_time INTEGER DEFAULT 0,
                    session_count INTEGER DEFAULT 0,
                    keystrokes INTEGER DEFAULT 0,
                    lines_added INTEGER DEFAULT 0,
                    lines_removed INTEGER DEFAULT 0,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `
        );

        await this.run('CREATE INDEX IF NOT EXISTS idx_segments_session_id ON session_segments(session_id)');
        await this.run('CREATE INDEX IF NOT EXISTS idx_segments_start_time ON session_segments(start_time)');
        await this.run('CREATE INDEX IF NOT EXISTS idx_rollups_date ON daily_rollups(date)');
        await this.createBaseIndexes();
    }

    private async createBaseIndexes(): Promise<void> {
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time)',
            'CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)',
            'CREATE INDEX IF NOT EXISTS idx_sessions_language ON sessions(language)',
            'CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type)'
        ];

        for (const sql of indexes) {
            await this.run(sql);
        }
    }

    private async addColumnIfMissing(tableName: string, columnName: string, columnSql: string): Promise<void> {
        const columns = await this.all<{ name: string }>(`PRAGMA table_info(${tableName})`);
        if (!columns.some(column => column.name === columnName)) {
            await this.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`);
        }
    }

    private async setSchemaVersion(version: number): Promise<void> {
        await this.run(
            `
                UPDATE meta
                SET value = ?
                WHERE key = 'schema_version'
            `,
            [String(version)]
        );
    }

    private async getAllSessions(): Promise<DatabaseSession[]> {
        const rows = await this.all<any>('SELECT * FROM sessions ORDER BY start_time ASC');
        return rows.map(row => this.mapRowToSession(row));
    }

    private async getAllActivities(): Promise<ActivityEvent[]> {
        const rows = await this.all<any>('SELECT * FROM activities ORDER BY timestamp ASC');
        return rows.map(row => this.mapRowToActivity(row));
    }

    private async getAllSegments(): Promise<SessionSegment[]> {
        const rows = await this.all<any>('SELECT * FROM session_segments ORDER BY start_time ASC');
        return rows.map(row => this.mapRowToSegment(row));
    }

    private async getAllDailyRollups(): Promise<DailyRollup[]> {
        const rows = await this.all<any>('SELECT * FROM daily_rollups ORDER BY date ASC');
        return rows.map(row => ({
            date: row.date,
            totalTime: row.total_time,
            idleTime: row.idle_time,
            sessionCount: row.session_count,
            keystrokes: row.keystrokes,
            linesAdded: row.lines_added,
            linesRemoved: row.lines_removed,
            updatedAt: row.updated_at
        }));
    }

    private mapRowToSession(row: any): DatabaseSession {
        return {
            id: row.id,
            startTime: new Date(row.start_time),
            endTime: row.end_time ? new Date(row.end_time) : undefined,
            duration: row.duration,
            idleDuration: row.idle_duration || 0,
            project: row.project,
            language: row.language,
            file: row.file,
            branch: row.branch,
            isActive: row.is_active === 1,
            heartbeats: row.heartbeats,
            keystrokes: row.keystrokes,
            linesAdded: row.lines_added,
            linesRemoved: row.lines_removed,
            productivityScore: row.productivity_score ?? undefined,
            created_at: row.created_at,
            updated_at: row.updated_at
        };
    }

    private mapRowToActivity(row: any): ActivityEvent {
        return {
            type: row.type as ActivityEvent['type'],
            timestamp: new Date(row.timestamp),
            sessionId: row.session_id || undefined,
            file: row.file || undefined,
            language: row.language || undefined,
            project: row.project || undefined,
            isIdle: row.is_idle === 1,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined
        };
    }

    private mapRowToSegment(row: any): SessionSegment {
        return {
            id: row.id,
            sessionId: row.session_id,
            segmentType: row.segment_type,
            startTime: new Date(row.start_time),
            endTime: row.end_time ? new Date(row.end_time) : undefined,
            duration: row.duration,
            project: row.project,
            language: row.language,
            file: row.file
        };
    }

    private async run(sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            this.db!.run(sql, params, function (this: sqlite3.RunResult, err: Error | null) {
                if (err) {
                    reject(new Error(err.message));
                } else {
                    resolve({
                        lastID: this.lastID ?? 0,
                        changes: this.changes ?? 0
                    });
                }
            });
        });
    }

    private async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            this.db!.get(sql, params, (err, row: T) => {
                if (err) {
                    reject(new Error(err.message));
                } else {
                    resolve(row);
                }
            });
        });
    }

    private async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        return new Promise((resolve, reject) => {
            this.db!.all(sql, params, (err, rows: T[]) => {
                if (err) {
                    reject(new Error(err.message));
                } else {
                    resolve(rows || []);
                }
            });
        });
    }
}
