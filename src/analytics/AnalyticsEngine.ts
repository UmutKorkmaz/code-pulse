import { DatabaseManager } from '../storage/DatabaseManager';
import { DailyStats } from '../tracker/TimeTracker';
import { ConfigManager } from '../utils/ConfigManager';
import { eachLocalDate, formatLocalDate } from '../utils/DateUtils';

export interface TimeDistribution {
    [hour: number]: number; // Hour of day (0-23) -> milliseconds
}

export interface WeeklyPattern {
    [dayOfWeek: number]: number; // Day of week (0-6, Sunday=0) -> milliseconds
}

export interface ProductivityTrend {
    date: string;
    score: number;
    totalTime: number;
    activeTime: number;
    sessions: number;
}

export interface LanguageStats {
    language: string;
    totalTime: number;
    percentage: number;
    sessions: number;
    avgSessionTime: number;
    productivity: number;
}

export interface ProjectStats {
    project: string;
    totalTime: number;
    percentage: number;
    sessions: number;
    avgSessionTime: number;
    productivity: number;
    topLanguages: { [language: string]: number };
}

export interface CodingStreak {
    currentStreak: number;
    longestStreak: number;
    streakStartDate?: Date;
    streakEndDate?: Date;
}

export interface DetailedAnalytics {
    totalCodingTime: number;
    totalSessions: number;
    avgSessionTime: number;
    timeDistribution: TimeDistribution;
    weeklyPattern: WeeklyPattern;
    productivityTrends: ProductivityTrend[];
    languageStats: LanguageStats[];
    projectStats: ProjectStats[];
    codingStreak: CodingStreak;
    topFiles: { file: string; time: number; percentage: number }[];
}

export class AnalyticsEngine {
    constructor(
        private databaseManager: DatabaseManager,
        private configManager: ConfigManager
    ) {}

    public async getDailyStats(date: string): Promise<DailyStats> {
        const sessions = await this.databaseManager.getSessionsByDate(date);
        
        if (sessions.length === 0) {
            return {
                date,
                totalTime: 0,
                activeTime: 0,
                idleTime: 0,
                sessionCount: 0,
                projects: {},
                languages: {},
                files: {},
                productivity: {
                    score: 0,
                    coding: 0,
                    debugging: 0,
                    building: 0
                }
            };
        }

        const totalTime = sessions.reduce((sum, session) => sum + session.duration, 0);
        const idleTime = sessions.reduce((sum, session) => sum + session.idleDuration, 0);
        const activeTime = totalTime;
        const sessionCount = sessions.length;
        const shouldIncludeProjects = this.configManager.get('analytics.enableProjectStats', true);
        const shouldIncludeLanguages = this.configManager.get('analytics.enableLanguageStats', true);
        const shouldIncludeFiles = this.configManager.shouldTrackFilenames();

        const projects: { [key: string]: number } = {};
        if (shouldIncludeProjects) {
            sessions.forEach(session => {
                projects[session.project] = (projects[session.project] || 0) + session.duration;
            });
        }

        const languages: { [key: string]: number } = {};
        if (shouldIncludeLanguages) {
            sessions.forEach(session => {
                languages[session.language] = (languages[session.language] || 0) + session.duration;
            });
        }

        const files: { [key: string]: number } = {};
        if (shouldIncludeFiles) {
            sessions.forEach(session => {
                const fileName = this.getFileBaseName(session.file);
                files[fileName] = (files[fileName] || 0) + session.duration;
            });
        }

        const productivity = this.calculateProductivityMetrics(sessions);

        return {
            date,
            totalTime,
            activeTime,
            idleTime,
            sessionCount,
            projects,
            languages,
            files,
            productivity
        };
    }

    public async getWeeklyStats(startDate: Date, endDate: Date): Promise<DailyStats[]> {
        const dates = eachLocalDate(startDate, endDate);
        return Promise.all(dates.map((date) => this.getDailyStats(date)));
    }

    public async getDetailedAnalytics(startDate: Date, endDate: Date): Promise<DetailedAnalytics> {
        const sessions = await this.databaseManager.getSessionsByDateRange(startDate, endDate);
        
        if (sessions.length === 0) {
            return this.getEmptyAnalytics();
        }

        const totalCodingTime = sessions.reduce((sum, session) => sum + session.duration, 0);
        const totalSessions = sessions.length;
        const avgSessionTime = totalCodingTime / totalSessions;

        const timeDistribution = this.calculateTimeDistribution(sessions);
        const weeklyPattern = this.calculateWeeklyPattern(sessions);
        const productivityTrends = await this.calculateProductivityTrends(startDate, endDate);
        const languageStats = this.configManager.get('analytics.enableLanguageStats', true)
            ? await this.calculateLanguageStats(sessions, totalCodingTime)
            : [];
        const projectStats = this.configManager.get('analytics.enableProjectStats', true)
            ? await this.calculateProjectStats(sessions, totalCodingTime)
            : [];
        const codingStreak = await this.calculateCodingStreak(endDate);
        const topFiles = await this.calculateTopFiles(sessions, totalCodingTime);

        return {
            totalCodingTime,
            totalSessions,
            avgSessionTime,
            timeDistribution,
            weeklyPattern,
            productivityTrends,
            languageStats,
            projectStats,
            codingStreak,
            topFiles
        };
    }

    public async getLanguageStats(startDate: Date, endDate: Date): Promise<LanguageStats[]> {
        if (!this.configManager.get('analytics.enableLanguageStats', true)) {
            return [];
        }

        const sessions = await this.databaseManager.getSessionsByDateRange(startDate, endDate);
        const totalTime = sessions.reduce((sum, session) => sum + session.duration, 0);
        
        return this.calculateLanguageStats(sessions, totalTime);
    }

    public async getProjectStats(startDate: Date, endDate: Date): Promise<ProjectStats[]> {
        if (!this.configManager.get('analytics.enableProjectStats', true)) {
            return [];
        }

        const sessions = await this.databaseManager.getSessionsByDateRange(startDate, endDate);
        const totalTime = sessions.reduce((sum, session) => sum + session.duration, 0);
        
        return this.calculateProjectStats(sessions, totalTime);
    }

    public async getCodingStreak(currentDate: Date = new Date()): Promise<CodingStreak> {
        return this.calculateCodingStreak(currentDate);
    }

    public async getProductivityTrends(startDate: Date, endDate: Date): Promise<ProductivityTrend[]> {
        return this.calculateProductivityTrends(startDate, endDate);
    }

    private calculateTimeDistribution(sessions: any[]): TimeDistribution {
        const distribution: TimeDistribution = {};
        
        // Initialize all hours
        for (let hour = 0; hour < 24; hour++) {
            distribution[hour] = 0;
        }

        sessions.forEach(session => {
            const hour = session.startTime.getHours();
            distribution[hour] += session.duration;
        });

        return distribution;
    }

    private calculateWeeklyPattern(sessions: any[]): WeeklyPattern {
        const pattern: WeeklyPattern = {};
        
        // Initialize all days
        for (let day = 0; day < 7; day++) {
            pattern[day] = 0;
        }

        sessions.forEach(session => {
            const dayOfWeek = session.startTime.getDay();
            pattern[dayOfWeek] += session.duration;
        });

        return pattern;
    }

    private async calculateProductivityTrends(startDate: Date, endDate: Date): Promise<ProductivityTrend[]> {
        const trends: ProductivityTrend[] = [];
        for (const dateString of eachLocalDate(startDate, endDate)) {
            const sessions = await this.databaseManager.getSessionsByDate(dateString);
            
            const totalTime = sessions.reduce((sum, session) => sum + session.duration, 0);
            const activeTime = totalTime;
            
            const productivity = this.calculateProductivityMetrics(sessions);

            trends.push({
                date: dateString,
                score: productivity.score,
                totalTime,
                activeTime,
                sessions: sessions.length
            });
        }

        return trends;
    }

    private async calculateLanguageStats(sessions: any[], totalTime: number): Promise<LanguageStats[]> {
        const languageMap = new Map<string, {
            totalTime: number;
            sessions: number;
            productivitySum: number;
        }>();

        sessions.forEach(session => {
            const current = languageMap.get(session.language) || {
                totalTime: 0,
                sessions: 0,
                productivitySum: 0
            };

            current.totalTime += session.duration;
            current.sessions += 1;
            current.productivitySum += session.productivityScore || 0;

            languageMap.set(session.language, current);
        });

        return Array.from(languageMap.entries())
            .map(([language, stats]) => ({
                language,
                totalTime: stats.totalTime,
                percentage: totalTime > 0 ? (stats.totalTime / totalTime) * 100 : 0,
                sessions: stats.sessions,
                avgSessionTime: stats.totalTime / stats.sessions,
                productivity: stats.sessions > 0 ? stats.productivitySum / stats.sessions : 0
            }))
            .sort((a, b) => b.totalTime - a.totalTime);
    }

    private async calculateProjectStats(sessions: any[], totalTime: number): Promise<ProjectStats[]> {
        const projectMap = new Map<string, {
            totalTime: number;
            sessions: number;
            productivitySum: number;
            languages: Map<string, number>;
        }>();

        sessions.forEach(session => {
            const current = projectMap.get(session.project) || {
                totalTime: 0,
                sessions: 0,
                productivitySum: 0,
                languages: new Map<string, number>()
            };

            current.totalTime += session.duration;
            current.sessions += 1;
            current.productivitySum += session.productivityScore || 0;
            current.languages.set(
                session.language,
                (current.languages.get(session.language) || 0) + session.duration
            );

            projectMap.set(session.project, current);
        });

        return Array.from(projectMap.entries())
            .map(([project, stats]) => {
                const topLanguages: { [language: string]: number } = {};
                stats.languages.forEach((time, language) => {
                    topLanguages[language] = time;
                });

                return {
                    project,
                    totalTime: stats.totalTime,
                    percentage: totalTime > 0 ? (stats.totalTime / totalTime) * 100 : 0,
                    sessions: stats.sessions,
                    avgSessionTime: stats.totalTime / stats.sessions,
                    productivity: stats.sessions > 0 ? stats.productivitySum / stats.sessions : 0,
                    topLanguages
                };
            })
            .sort((a, b) => b.totalTime - a.totalTime);
    }

    private async calculateCodingStreak(currentDate: Date): Promise<CodingStreak> {
        let currentStreak = 0;
        let longestStreak = 0;
        let currentStreakStart: Date | undefined;
        let longestStreakEnd: Date | undefined;
        let tempStreakStart: Date | undefined;

        // Check backwards from current date
        const date = new Date(currentDate);
        date.setHours(23, 59, 59, 999); // End of day

        while (true) {
            const dateString = formatLocalDate(date);
            const sessions = await this.databaseManager.getSessionsByDate(dateString);
            const hasCoding = sessions.length > 0 && sessions.some(s => s.duration > 0);

            if (hasCoding) {
                currentStreak++;
                if (!currentStreakStart) {
                    currentStreakStart = new Date(date);
                }
                if (!tempStreakStart) {
                    tempStreakStart = new Date(date);
                }
                
                if (currentStreak > longestStreak) {
                    longestStreak = currentStreak;
                    longestStreakEnd = new Date(date);
                }
            } else {
                if (currentStreak > 0) {
                    // End of current streak
                    break;
                }
                currentStreak = 0;
                tempStreakStart = undefined;
            }

            date.setDate(date.getDate() - 1);
            
            // Prevent infinite loop - check only last 365 days
            if (new Date().getTime() - date.getTime() > 365 * 24 * 60 * 60 * 1000) {
                break;
            }
        }

        return {
            currentStreak,
            longestStreak,
            streakStartDate: currentStreakStart,
            streakEndDate: longestStreakEnd
        };
    }

    private async calculateTopFiles(sessions: any[], totalTime: number): Promise<{ file: string; time: number; percentage: number }[]> {
        const fileMap = new Map<string, number>();

        sessions.forEach(session => {
            const fileName = this.getFileBaseName(session.file);
            fileMap.set(fileName, (fileMap.get(fileName) || 0) + session.duration);
        });

        return Array.from(fileMap.entries())
            .map(([file, time]) => ({
                file,
                time,
                percentage: totalTime > 0 ? (time / totalTime) * 100 : 0
            }))
            .sort((a, b) => b.time - a.time)
            .slice(0, 20); // Top 20 files
    }

    private calculateProductivityMetrics(sessions: any[]): {
        score: number;
        coding: number;
        debugging: number;
        building: number;
    } {
        if (!this.configManager.get('analytics.enableProductivityScore', true)) {
            return { score: 0, coding: 0, debugging: 0, building: 0 };
        }

        if (sessions.length === 0) {
            return { score: 0, coding: 0, debugging: 0, building: 0 };
        }

        const totalScore = sessions.reduce((sum, session) => sum + (session.productivityScore || 0), 0);
        const avgScore = totalScore / sessions.length;

        // Simplified breakdown - in a real implementation, you'd have more sophisticated categorization
        const coding = avgScore * 0.6;
        const debugging = avgScore * 0.25;
        const building = avgScore * 0.15;

        return {
            score: avgScore,
            coding,
            debugging,
            building
        };
    }

    private getFileBaseName(filePath: string): string {
        if (!this.configManager.shouldTrackFilenames()) {
            return 'hidden';
        }

        if (!filePath) {
            return 'untitled';
        }
        
        const parts = filePath.split(/[/\\]/);
        return parts[parts.length - 1] || 'untitled';
    }

    private getEmptyAnalytics(): DetailedAnalytics {
        return {
            totalCodingTime: 0,
            totalSessions: 0,
            avgSessionTime: 0,
            timeDistribution: {},
            weeklyPattern: {},
            productivityTrends: [],
            languageStats: [],
            projectStats: [],
            codingStreak: {
                currentStreak: 0,
                longestStreak: 0
            },
            topFiles: []
        };
    }
}
