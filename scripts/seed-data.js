#!/usr/bin/env node
/**
 * Seed Code Pulse database with ~2 years of realistic coding session data.
 *
 * Usage:
 *   node scripts/seed-data.js                  # seeds default storage path
 *   node scripts/seed-data.js /path/to/db.db   # seed specific path
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const crypto = require('crypto');

// ---------- Config ----------
const DEFAULT_DB = path.join(
    os.homedir(),
    'Library/Application Support/Code/User/globalStorage/codepulse.codepulse/codepulse.db'
);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const DB_PATH = args[0] || DEFAULT_DB;

// 2 years of data ending today
const END_DATE = new Date();
const START_DATE = new Date();
START_DATE.setDate(START_DATE.getDate() - 730);

// Realistic project mix (ordered by era — older projects phased out)
const PROJECTS = [
    { name: 'tasirimkurye', weight: 0.25, period: [0, 730], languages: ['dart', 'javascript'] },
    { name: 'code-pulse', weight: 0.18, period: [0, 120], languages: ['typescript'] },
    { name: 'integlion', weight: 0.15, period: [30, 400], languages: ['typescript', 'python'] },
    { name: 'yazilimci-bul', weight: 0.12, period: [100, 600], languages: ['dart', 'javascript'] },
    { name: 'claude-automation', weight: 0.1, period: [0, 300], languages: ['typescript', 'python'] },
    { name: 'e-commerce-api', weight: 0.08, period: [400, 730], languages: ['typescript', 'go'] },
    { name: 'mobile-courier', weight: 0.07, period: [200, 730], languages: ['dart', 'kotlin'] },
    { name: 'admin-panel', weight: 0.05, period: [300, 730], languages: ['typescript'] }
];

const LANGUAGES = {
    typescript: { productive: 80 },
    dart: { productive: 75 },
    python: { productive: 70 },
    javascript: { productive: 65 },
    go: { productive: 78 },
    kotlin: { productive: 72 },
    json: { productive: 30 },
    markdown: { productive: 25 }
};

const FILES_BY_LANG = {
    typescript: ['index.ts', 'app.ts', 'server.ts', 'routes.ts', 'auth.ts', 'db.ts', 'utils.ts', 'types.ts'],
    dart: ['main.dart', 'home_screen.dart', 'auth_service.dart', 'order_model.dart', 'api_client.dart'],
    python: ['main.py', 'models.py', 'views.py', 'tasks.py', 'config.py', 'utils.py'],
    javascript: ['index.js', 'app.js', 'server.js', 'config.js', 'webpack.config.js'],
    go: ['main.go', 'handler.go', 'server.go', 'db.go', 'middleware.go'],
    kotlin: ['MainActivity.kt', 'ViewModel.kt', 'Repository.kt', 'AuthService.kt'],
    json: ['package.json', 'tsconfig.json', 'config.json'],
    markdown: ['README.md', 'CHANGELOG.md', 'NOTES.md']
};

// ---------- Helpers ----------
function randBetween(min, max) {
    return Math.random() * (max - min) + min;
}
function randInt(min, max) {
    return Math.floor(randBetween(min, max + 1));
}
function choice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function weightedChoice(items) {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = Math.random() * total;
    for (const item of items) {
        r -= item.weight;
        if (r <= 0) return item;
    }
    return items[items.length - 1];
}

function formatLocalDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function genSessionId(startTime) {
    return `${startTime.getTime()}-${crypto.randomBytes(4).toString('hex').slice(0, 9)}`;
}

// Realistic daily hours — weekdays higher, weekends lower, with vacation weeks
function hoursForDay(date, daysFromStart) {
    const dow = date.getDay(); // 0=Sun, 6=Sat
    const weekNum = Math.floor(daysFromStart / 7);

    // ~4% of weeks are vacation (0 hours)
    if (crypto.createHash('md5').update(`vac-${weekNum}`).digest()[0] < 10) return 0;

    if (dow === 0) return Math.random() < 0.3 ? randBetween(0.5, 2) : 0;
    if (dow === 6) return Math.random() < 0.5 ? randBetween(1, 3) : 0;

    // Weekday: most days 4-8h, some burst days 8-12h, occasional light days 1-3h
    const r = Math.random();
    if (r < 0.1) return randBetween(1, 3); // light day
    if (r < 0.85) return randBetween(4, 8); // normal day
    return randBetween(8, 11); // crunch day
}

function eligibleProjects(daysFromStart) {
    const offset = 730 - daysFromStart;
    return PROJECTS.filter(p => offset >= p.period[0] && offset <= p.period[1]);
}

// ---------- DB Setup ----------
function initDb(db) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('PRAGMA foreign_keys = ON');
            db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
            db.run(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '3')`);
            db.run(`CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                start_time TEXT NOT NULL,
                end_time TEXT,
                duration INTEGER DEFAULT 0,
                idle_duration INTEGER DEFAULT 0,
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
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS activities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                session_id TEXT,
                file TEXT,
                language TEXT,
                project TEXT,
                is_idle INTEGER DEFAULT 0,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS session_segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                segment_type TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT,
                duration INTEGER DEFAULT 0,
                project TEXT NOT NULL,
                language TEXT NOT NULL,
                file TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS daily_rollups (
                date TEXT PRIMARY KEY,
                total_time INTEGER DEFAULT 0,
                idle_time INTEGER DEFAULT 0,
                session_count INTEGER DEFAULT 0,
                keystrokes INTEGER DEFAULT 0,
                lines_added INTEGER DEFAULT 0,
                lines_removed INTEGER DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run('CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time)');
            db.run('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)');
            db.run('CREATE INDEX IF NOT EXISTS idx_sessions_language ON sessions(language)', e =>
                e ? reject(e) : resolve()
            );
        });
    });
}

function runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

// ---------- Session generator ----------
function generateSessionsForDay(date, daysFromStart, totalHours) {
    if (totalHours === 0) return [];

    const sessions = [];
    let remainingMs = totalHours * 60 * 60 * 1000;
    const eligible = eligibleProjects(daysFromStart);
    if (eligible.length === 0) return [];

    // Start time distribution: weighted toward 9-11am, 2-4pm, 8-10pm
    const dayStart = new Date(date);
    dayStart.setHours(9, 0, 0, 0);
    let cursor = new Date(dayStart.getTime() + randBetween(-60, 120) * 60 * 1000);

    while (remainingMs > 5 * 60 * 1000) {
        // Session length: 25-120 min active, with gaps
        const activeMs = Math.min(remainingMs, randBetween(25, 120) * 60 * 1000);
        const idleMs = Math.min(activeMs * randBetween(0.05, 0.2), 15 * 60 * 1000);
        const project = weightedChoice(eligible);
        const language = choice(project.languages);
        const file = choice(FILES_BY_LANG[language] || ['main']);
        const keystrokesPerMin = randBetween(80, 350);
        const keystrokes = Math.round((activeMs / 60000) * keystrokesPerMin);
        const linesAdded = Math.round(keystrokes * randBetween(0.008, 0.02));
        const linesRemoved = Math.round(linesAdded * randBetween(0.15, 0.5));
        const heartbeats = Math.round(activeMs / (2 * 60 * 1000));
        const baseScore = LANGUAGES[language]?.productive || 60;
        const productivityScore = Math.max(0, Math.min(100, baseScore + randBetween(-15, 15)));

        const startTime = new Date(cursor);
        const endTime = new Date(cursor.getTime() + activeMs + idleMs);

        sessions.push({
            id: genSessionId(startTime),
            startTime,
            endTime,
            duration: Math.round(activeMs),
            idleDuration: Math.round(idleMs),
            project: project.name,
            language,
            file: `/Users/dtumkorkmaz/Projects/${project.name}/src/${file}`,
            branch: Math.random() < 0.6 ? 'main' : choice(['feat/ui', 'fix/auth', 'refactor/api', 'dev']),
            heartbeats,
            keystrokes,
            linesAdded,
            linesRemoved,
            productivityScore: Math.round(productivityScore)
        });

        cursor = new Date(endTime.getTime() + randBetween(5, 45) * 60 * 1000); // break
        remainingMs -= activeMs;

        // Stop if past 11pm
        if (cursor.getHours() >= 23) break;
    }

    return sessions;
}

// ---------- Main ----------
async function main() {
    console.log(`Seeding database at: ${DB_PATH}`);
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    const db = new sqlite3.Database(DB_PATH);
    await initDb(db);

    // Optional: clear existing data first
    if (process.argv.includes('--reset')) {
        console.log('Resetting existing data...');
        await runAsync(db, 'DELETE FROM session_segments');
        await runAsync(db, 'DELETE FROM daily_rollups');
        await runAsync(db, 'DELETE FROM activities');
        await runAsync(db, 'DELETE FROM sessions');
    }

    const totalDays = Math.ceil((END_DATE - START_DATE) / (24 * 60 * 60 * 1000));
    let sessionCount = 0;
    let segmentCount = 0;
    let rollupCount = 0;

    console.log(`Generating ${totalDays} days of sessions...`);
    await runAsync(db, 'BEGIN TRANSACTION');

    try {
        for (let i = 0; i < totalDays; i++) {
            const date = new Date(START_DATE);
            date.setDate(date.getDate() + i);
            const hours = hoursForDay(date, i);
            const sessions = generateSessionsForDay(date, i, hours);

            let dailyTotal = 0,
                dailyIdle = 0,
                dailyKeys = 0,
                dailyAdd = 0,
                dailyRem = 0;

            for (const s of sessions) {
                await runAsync(
                    db,
                    `INSERT INTO sessions (id, start_time, end_time, duration, idle_duration, project, language, file, branch, is_active, heartbeats, keystrokes, lines_added, lines_removed, productivity_score)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
                    [
                        s.id,
                        s.startTime.toISOString(),
                        s.endTime.toISOString(),
                        s.duration,
                        s.idleDuration,
                        s.project,
                        s.language,
                        s.file,
                        s.branch,
                        s.heartbeats,
                        s.keystrokes,
                        s.linesAdded,
                        s.linesRemoved,
                        s.productivityScore
                    ]
                );
                await runAsync(
                    db,
                    `INSERT INTO session_segments (session_id, segment_type, start_time, end_time, duration, project, language, file)
                     VALUES (?, 'active', ?, ?, ?, ?, ?, ?)`,
                    [
                        s.id,
                        s.startTime.toISOString(),
                        s.endTime.toISOString(),
                        s.duration,
                        s.project,
                        s.language,
                        s.file
                    ]
                );
                sessionCount++;
                segmentCount++;
                dailyTotal += s.duration;
                dailyIdle += s.idleDuration;
                dailyKeys += s.keystrokes;
                dailyAdd += s.linesAdded;
                dailyRem += s.linesRemoved;
            }

            if (sessions.length > 0) {
                const dateStr = formatLocalDate(date);
                await runAsync(
                    db,
                    `INSERT INTO daily_rollups (date, total_time, idle_time, session_count, keystrokes, lines_added, lines_removed)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [dateStr, dailyTotal, dailyIdle, sessions.length, dailyKeys, dailyAdd, dailyRem]
                );
                rollupCount++;
            }

            if ((i + 1) % 50 === 0) {
                process.stdout.write(`\r  Progress: ${i + 1}/${totalDays} days, ${sessionCount} sessions`);
            }
        }

        await runAsync(db, 'COMMIT');
    } catch (err) {
        await runAsync(db, 'ROLLBACK');
        throw err;
    }

    console.log(`\n\n✓ Seeded successfully:`);
    console.log(`  Sessions:       ${sessionCount.toLocaleString()}`);
    console.log(`  Segments:       ${segmentCount.toLocaleString()}`);
    console.log(`  Daily rollups:  ${rollupCount.toLocaleString()}`);
    console.log(`  Date range:     ${formatLocalDate(START_DATE)} → ${formatLocalDate(END_DATE)}`);
    console.log(`  DB path:        ${DB_PATH}`);

    db.close();
}

main().catch(err => {
    console.error('Seeding failed:', err);
    process.exit(1);
});
