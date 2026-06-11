import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
    timestamp: Date;
    level: LogLevel;
    message: string;
    error?: Error;
    metadata?: { [key: string]: any };
}

export class Logger {
    private logFilePath: string;
    private logLevel: LogLevel = 'info';
    private maxLogFileSize = 10 * 1024 * 1024; // 10MB
    private maxLogFiles = 5;
    private logBuffer: LogEntry[] = [];
    private bufferFlushInterval = 5000; // 5 seconds
    private flushTimer?: NodeJS.Timeout;
    // Serializes async file writes so timer flushes never interleave appends.
    private writeChain: Promise<void> = Promise.resolve();

    constructor(logDirectoryPath: string, logLevel: LogLevel = 'info') {
        this.logFilePath = logDirectoryPath.endsWith('.log')
            ? logDirectoryPath
            : path.join(logDirectoryPath, 'codepulse.log');
        this.logLevel = logLevel;

        this.ensureLogDirectory();
        this.startBufferFlushing();
    }

    public debug(message: string, error?: Error, metadata?: { [key: string]: any }): void {
        this.log('debug', message, error, metadata);
    }

    public info(message: string, error?: Error, metadata?: { [key: string]: any }): void {
        this.log('info', message, error, metadata);
    }

    public warn(message: string, error?: Error, metadata?: { [key: string]: any }): void {
        this.log('warn', message, error, metadata);
    }

    public error(message: string, error?: Error, metadata?: { [key: string]: any }): void {
        this.log('error', message, error, metadata);
    }

    public setLogLevel(level: LogLevel): void {
        this.logLevel = level;
    }

    public getLogLevel(): LogLevel {
        return this.logLevel;
    }

    public async getLogs(lines = 100): Promise<string[]> {
        try {
            if (!fs.existsSync(this.logFilePath)) {
                return [];
            }

            const data = await fs.promises.readFile(this.logFilePath, 'utf8');
            const logLines = data.split('\n').filter(line => line.trim() !== '');

            return logLines.slice(-lines);
        } catch (error) {
            console.error('Failed to read log file:', error);
            return [];
        }
    }

    public async clearLogs(): Promise<void> {
        try {
            if (fs.existsSync(this.logFilePath)) {
                await fs.promises.unlink(this.logFilePath);
            }
            this.logBuffer = [];
        } catch (error) {
            console.error('Failed to clear log file:', error);
        }
    }

    public async exportLogs(): Promise<string> {
        const logs = await this.getLogs(1000); // Get last 1000 lines
        return logs.join('\n');
    }

    public flush(): void {
        this.flushBuffer();
    }

    public dispose(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = undefined;
        }
        this.flushBuffer();
    }

    private log(level: LogLevel, message: string, error?: Error, metadata?: { [key: string]: any }): void {
        if (!this.shouldLog(level)) {
            return;
        }

        const entry: LogEntry = {
            timestamp: new Date(),
            level,
            message,
            error,
            metadata
        };

        // Also log to console in development
        if (process.env.NODE_ENV === 'development') {
            this.logToConsole(entry);
        }

        this.logBuffer.push(entry);

        // Immediate flush for error level
        if (level === 'error') {
            this.flushBuffer();
        }
    }

    private shouldLog(level: LogLevel): boolean {
        const levels = ['debug', 'info', 'warn', 'error'];
        const currentLevelIndex = levels.indexOf(this.logLevel);
        const messageLevelIndex = levels.indexOf(level);

        return messageLevelIndex >= currentLevelIndex;
    }

    private logToConsole(entry: LogEntry): void {
        const timestamp = entry.timestamp.toISOString();
        const message = `[${timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`;

        switch (entry.level) {
            case 'debug':
                console.debug(message, entry.metadata);
                break;
            case 'info':
                console.info(message, entry.metadata);
                break;
            case 'warn':
                console.warn(message, entry.metadata);
                if (entry.error) {
                    console.warn(entry.error);
                }
                break;
            case 'error':
                console.error(message, entry.metadata);
                if (entry.error) {
                    console.error(entry.error);
                }
                break;
        }
    }

    private ensureLogDirectory(): void {
        const logDir = path.dirname(this.logFilePath);

        if (!fs.existsSync(logDir)) {
            try {
                fs.mkdirSync(logDir, { recursive: true });
            } catch (error) {
                console.error('Failed to create log directory:', error);
            }
        }
    }

    private startBufferFlushing(): void {
        this.flushTimer = setInterval(() => {
            this.flushBufferAsync();
        }, this.bufferFlushInterval);
    }

    /**
     * Timer-driven flush: non-blocking fs.promises writes chained one after the
     * other so appends never interleave. Error-level and dispose() flushes stay
     * on the synchronous path (flushBuffer) for crash/shutdown safety.
     */
    private flushBufferAsync(): void {
        if (this.logBuffer.length === 0) {
            return;
        }

        const entries = [...this.logBuffer];
        this.logBuffer = [];

        this.writeChain = this.writeChain.then(async () => {
            try {
                await this.writeLogEntriesAsync(entries);
            } catch (error) {
                console.error('Failed to write log entries:', error);
                // Return entries to buffer for retry
                this.logBuffer.unshift(...entries);
            }
        });
    }

    private flushBuffer(): void {
        if (this.logBuffer.length === 0) {
            return;
        }

        const entries = [...this.logBuffer];
        this.logBuffer = [];

        try {
            this.writeLogEntries(entries);
        } catch (error) {
            console.error('Failed to write log entries:', error);
            // Return entries to buffer for retry
            this.logBuffer.unshift(...entries);
        }
    }

    private buildLogData(entries: LogEntry[]): string {
        return entries.map(entry => this.formatLogEntry(entry)).join('\n') + '\n';
    }

    private async writeLogEntriesAsync(entries: LogEntry[]): Promise<void> {
        const logData = this.buildLogData(entries);

        try {
            // Check if log rotation is needed
            const stats = await fs.promises.stat(this.logFilePath).catch(() => null);
            if (stats && stats.size > this.maxLogFileSize) {
                await this.rotateLogFileAsync();
            }

            // Append to log file
            await fs.promises.appendFile(this.logFilePath, logData, 'utf8');

        } catch (error) {
            console.error('Failed to write to log file:', error);
            throw error;
        }
    }

    private writeLogEntries(entries: LogEntry[]): void {
        const logData = this.buildLogData(entries);

        try {
            // Check if log rotation is needed
            if (fs.existsSync(this.logFilePath)) {
                const stats = fs.statSync(this.logFilePath);
                if (stats.size > this.maxLogFileSize) {
                    this.rotateLogFile();
                }
            }

            // Append to log file
            fs.appendFileSync(this.logFilePath, logData, 'utf8');

        } catch (error) {
            console.error('Failed to write to log file:', error);
            throw error;
        }
    }

    private formatLogEntry(entry: LogEntry): string {
        const timestamp = entry.timestamp.toISOString();
        const level = entry.level.toUpperCase().padEnd(5);
        let logLine = `[${timestamp}] [${level}] ${entry.message}`;

        if (entry.metadata) {
            try {
                logLine += ` | ${JSON.stringify(entry.metadata)}`;
            } catch (error) {
                logLine += ` | [Unable to serialize metadata]`;
            }
        }

        if (entry.error) {
            logLine += `\nError: ${entry.error.message}`;
            if (entry.error.stack) {
                logLine += `\nStack: ${entry.error.stack}`;
            }
        }

        return logLine;
    }

    private async rotateLogFileAsync(): Promise<void> {
        try {
            const logDir = path.dirname(this.logFilePath);
            const logName = path.basename(this.logFilePath, path.extname(this.logFilePath));
            const logExt = path.extname(this.logFilePath);

            // Rotate existing files
            for (let i = this.maxLogFiles - 1; i >= 1; i--) {
                const currentFile = path.join(logDir, `${logName}.${i}${logExt}`);
                const nextFile = path.join(logDir, `${logName}.${i + 1}${logExt}`);

                const exists = await fs.promises.stat(currentFile).then(() => true, () => false);
                if (exists) {
                    if (i === this.maxLogFiles - 1) {
                        // Delete the oldest file
                        await fs.promises.unlink(currentFile);
                    } else {
                        // Rename to next number
                        await fs.promises.rename(currentFile, nextFile);
                    }
                }
            }

            // Rename current log file
            const rotatedFile = path.join(logDir, `${logName}.1${logExt}`);
            await fs.promises.rename(this.logFilePath, rotatedFile);

        } catch (error) {
            console.error('Failed to rotate log file:', error);
        }
    }

    private rotateLogFile(): void {
        try {
            const logDir = path.dirname(this.logFilePath);
            const logName = path.basename(this.logFilePath, path.extname(this.logFilePath));
            const logExt = path.extname(this.logFilePath);

            // Rotate existing files
            for (let i = this.maxLogFiles - 1; i >= 1; i--) {
                const currentFile = path.join(logDir, `${logName}.${i}${logExt}`);
                const nextFile = path.join(logDir, `${logName}.${i + 1}${logExt}`);

                if (fs.existsSync(currentFile)) {
                    if (i === this.maxLogFiles - 1) {
                        // Delete the oldest file
                        fs.unlinkSync(currentFile);
                    } else {
                        // Rename to next number
                        fs.renameSync(currentFile, nextFile);
                    }
                }
            }

            // Rename current log file
            const rotatedFile = path.join(logDir, `${logName}.1${logExt}`);
            fs.renameSync(this.logFilePath, rotatedFile);

        } catch (error) {
            console.error('Failed to rotate log file:', error);
        }
    }

    // Static utility methods
    public static createLogger(extensionPath: string, component?: string, logLevel: LogLevel = 'info'): Logger {
        const logger = new Logger(extensionPath, logLevel);

        // Add component prefix to messages
        if (component) {
            const originalLog = logger.log;
            logger.log = function(level: LogLevel, message: string, error?: Error, metadata?: any) {
                const prefixedMessage = `[${component}] ${message}`;
                return originalLog.call(this, level, prefixedMessage, error, metadata);
            };
        }

        return logger;
    }

    public static async analyzeLogs(logFilePath: string): Promise<{
        totalEntries: number;
        entriesByLevel: { [key in LogLevel]: number };
        recentErrors: string[];
        topErrors: Array<{ message: string; count: number }>;
    }> {
        try {
            if (!fs.existsSync(logFilePath)) {
                return {
                    totalEntries: 0,
                    entriesByLevel: { debug: 0, info: 0, warn: 0, error: 0 },
                    recentErrors: [],
                    topErrors: []
                };
            }

            const data = await fs.promises.readFile(logFilePath, 'utf8');
            const lines = data.split('\n').filter(line => line.trim() !== '');

            const entriesByLevel: { [key in LogLevel]: number } = { debug: 0, info: 0, warn: 0, error: 0 };
            const errors: string[] = [];
            const errorCounts = new Map<string, number>();

            lines.forEach(line => {
                // Parse log level
                const levelMatch = line.match(/\[(DEBUG|INFO|WARN|ERROR)\]/);
                if (levelMatch) {
                    const level = levelMatch[1].toLowerCase() as LogLevel;
                    entriesByLevel[level]++;

                    if (level === 'error') {
                        errors.push(line);

                        // Extract error message for counting
                        const messageMatch = line.match(/\] (.+?)(?:\s\||\n|$)/);
                        if (messageMatch) {
                            const message = messageMatch[1];
                            errorCounts.set(message, (errorCounts.get(message) || 0) + 1);
                        }
                    }
                }
            });

            const topErrors = Array.from(errorCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([message, count]) => ({ message, count }));

            return {
                totalEntries: lines.length,
                entriesByLevel,
                recentErrors: errors.slice(-20), // Last 20 errors
                topErrors
            };

        } catch (error) {
            console.error('Failed to analyze logs:', error);
            return {
                totalEntries: 0,
                entriesByLevel: { debug: 0, info: 0, warn: 0, error: 0 },
                recentErrors: [],
                topErrors: []
            };
        }
    }
}
