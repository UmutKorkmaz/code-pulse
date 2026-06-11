import { DatabaseManager } from '../storage/DatabaseManager';
import { CodingSession } from '../tracker/TimeTracker';
import { formatLocalDate } from '../utils/DateUtils';

export interface ProductivityFactors {
    keystrokeVelocity: number;
    focusTime: number;
    codeChurn: number;
    sessionConsistency: number;
    languageComplexity: number;
    projectFamiliarity: number;
    timeOfDay: number;
}

export interface ProductivityMetrics {
    overallScore: number;
    factors: ProductivityFactors;
    insights: string[];
    recommendations: string[];
}

export class ProductivityScorer {
    // Matches the ConfigManager 'heartbeatInterval' default of 120 seconds.
    private static readonly DEFAULT_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;

    private languageComplexityMap: Map<string, number> = new Map([
        ['assembly', 0.95],
        ['c', 0.85],
        ['cpp', 0.85],
        ['rust', 0.8],
        ['go', 0.75],
        ['java', 0.7],
        ['csharp', 0.7],
        ['kotlin', 0.7],
        ['scala', 0.75],
        ['swift', 0.7],
        ['typescript', 0.65],
        ['javascript', 0.6],
        ['python', 0.55],
        ['ruby', 0.55],
        ['php', 0.5],
        ['html', 0.3],
        ['css', 0.35],
        ['markdown', 0.2],
        ['json', 0.15],
        ['yaml', 0.2],
        ['xml', 0.25]
    ]);

    private peakProductivityHours: number[] = [9, 10, 11, 14, 15, 16]; // 9-11 AM and 2-4 PM

    private readonly heartbeatIntervalMs: number;

    constructor(private databaseManager: DatabaseManager, heartbeatIntervalMs?: number) {
        this.heartbeatIntervalMs =
            typeof heartbeatIntervalMs === 'number' && Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0
                ? heartbeatIntervalMs
                : ProductivityScorer.DEFAULT_HEARTBEAT_INTERVAL_MS;
    }

    public async calculateSessionScore(session: CodingSession): Promise<number> {
        const metrics = await this.calculateProductivityMetrics(session);
        return Math.round(metrics.overallScore);
    }

    public async calculateProductivityMetrics(session: CodingSession): Promise<ProductivityMetrics> {
        const factors: ProductivityFactors = {
            keystrokeVelocity: this.calculateKeystrokeVelocity(session),
            focusTime: this.calculateFocusTime(session),
            codeChurn: this.calculateCodeChurn(session),
            sessionConsistency: await this.calculateSessionConsistency(session),
            languageComplexity: this.calculateLanguageComplexity(session),
            projectFamiliarity: await this.calculateProjectFamiliarity(session),
            timeOfDay: this.calculateTimeOfDayScore(session)
        };

        const overallScore = this.calculateOverallScore(factors);
        const insights = this.generateInsights(factors, session);
        const recommendations = this.generateRecommendations(factors, session);

        return {
            overallScore,
            factors,
            insights,
            recommendations
        };
    }

    public async calculateDailyProductivityScore(date: string): Promise<number> {
        const sessions = await this.databaseManager.getSessionsByDate(date);

        if (sessions.length === 0) {
            return 0;
        }

        const totalTime = sessions.reduce((sum, session) => sum + session.duration, 0);
        const weightedScore = sessions.reduce((sum, session) => {
            const sessionScore = session.productivityScore || 0;
            const weight = session.duration / totalTime;
            return sum + sessionScore * weight;
        }, 0);

        return Math.round(weightedScore);
    }

    public async calculateWeeklyProductivityTrend(
        startDate: Date,
        endDate: Date
    ): Promise<{
        dates: string[];
        scores: number[];
        trend: 'improving' | 'declining' | 'stable';
        trendStrength: number;
    }> {
        const dates: string[] = [];
        const scores: number[] = [];
        const currentDate = new Date(startDate);

        while (currentDate <= endDate) {
            const dateString = formatLocalDate(currentDate);
            const score = await this.calculateDailyProductivityScore(dateString);

            dates.push(dateString);
            scores.push(score);

            currentDate.setDate(currentDate.getDate() + 1);
        }

        const { trend, strength } = this.analyzeTrend(scores);

        return {
            dates,
            scores,
            trend,
            trendStrength: strength
        };
    }

    public async getProductivityInsights(
        startDate: Date,
        endDate: Date
    ): Promise<{
        averageScore: number;
        bestDay: { date: string; score: number };
        worstDay: { date: string; score: number };
        topLanguage: { language: string; score: number };
        topProject: { project: string; score: number };
        peakHour: { hour: number; score: number };
        insights: string[];
    }> {
        const sessions = await this.databaseManager.getSessionsByDateRange(startDate, endDate);

        if (sessions.length === 0) {
            return {
                averageScore: 0,
                bestDay: { date: '', score: 0 },
                worstDay: { date: '', score: 0 },
                topLanguage: { language: '', score: 0 },
                topProject: { project: '', score: 0 },
                peakHour: { hour: 0, score: 0 },
                insights: ['No data available for the selected period.']
            };
        }

        const averageScore = sessions.reduce((sum, s) => sum + (s.productivityScore || 0), 0) / sessions.length;

        // Daily scores
        const dailyScores = new Map<string, number[]>();
        sessions.forEach(session => {
            const date = session.startTime.toISOString().split('T')[0];
            if (!dailyScores.has(date)) {
                dailyScores.set(date, []);
            }
            dailyScores.get(date)!.push(session.productivityScore || 0);
        });

        const dailyAverages = Array.from(dailyScores.entries()).map(([date, scores]) => ({
            date,
            score: scores.reduce((a, b) => a + b, 0) / scores.length
        }));

        const bestDay = dailyAverages.reduce((max, day) => (day.score > max.score ? day : max));
        const worstDay = dailyAverages.reduce((min, day) => (day.score < min.score ? day : min));

        // Language scores
        const languageScores = new Map<string, number[]>();
        sessions.forEach(session => {
            if (!languageScores.has(session.language)) {
                languageScores.set(session.language, []);
            }
            languageScores.get(session.language)!.push(session.productivityScore || 0);
        });

        const topLanguage = Array.from(languageScores.entries())
            .map(([language, scores]) => ({
                language,
                score: scores.reduce((a, b) => a + b, 0) / scores.length
            }))
            .reduce((max, lang) => (lang.score > max.score ? lang : max));

        // Project scores
        const projectScores = new Map<string, number[]>();
        sessions.forEach(session => {
            if (!projectScores.has(session.project)) {
                projectScores.set(session.project, []);
            }
            projectScores.get(session.project)!.push(session.productivityScore || 0);
        });

        const topProject = Array.from(projectScores.entries())
            .map(([project, scores]) => ({
                project,
                score: scores.reduce((a, b) => a + b, 0) / scores.length
            }))
            .reduce((max, proj) => (proj.score > max.score ? proj : max));

        // Peak hour
        const hourScores = new Map<number, number[]>();
        sessions.forEach(session => {
            const hour = session.startTime.getHours();
            if (!hourScores.has(hour)) {
                hourScores.set(hour, []);
            }
            hourScores.get(hour)!.push(session.productivityScore || 0);
        });

        const peakHour = Array.from(hourScores.entries())
            .map(([hour, scores]) => ({
                hour,
                score: scores.reduce((a, b) => a + b, 0) / scores.length
            }))
            .reduce((max, h) => (h.score > max.score ? h : max));

        const insights = this.generatePeriodInsights(sessions, dailyAverages);

        return {
            averageScore: Math.round(averageScore),
            bestDay,
            worstDay,
            topLanguage,
            topProject,
            peakHour,
            insights
        };
    }

    private calculateKeystrokeVelocity(session: CodingSession): number {
        if (session.duration === 0) {
            return 0;
        }

        const durationInMinutes = session.duration / (1000 * 60);
        const keystrokesPerMinute = session.keystrokes / durationInMinutes;

        // Normalize to 0-100 scale (assuming optimal is around 300-400 keystrokes per minute)
        const normalized = Math.min((keystrokesPerMinute / 350) * 100, 100);

        return Math.round(normalized);
    }

    private calculateFocusTime(session: CodingSession): number {
        if (session.duration === 0) {
            return 0;
        }

        // Calculate focus based on heartbeat consistency at the configured interval
        const expectedHeartbeats = Math.floor(session.duration / this.heartbeatIntervalMs);
        const heartbeatRatio = Math.min(session.heartbeats / Math.max(expectedHeartbeats, 1), 1);

        return Math.round(heartbeatRatio * 100);
    }

    private calculateCodeChurn(session: CodingSession): number {
        const totalLines = session.linesAdded + session.linesRemoved;

        if (totalLines === 0) {
            return 50; // Neutral score for sessions with no line changes
        }

        // Calculate churn ratio (removed / added)
        const churnRatio = session.linesRemoved / Math.max(session.linesAdded, 1);

        // Lower churn ratio is better (more additions than deletions)
        // Score inversely related to churn ratio
        const score = Math.max(0, 100 - churnRatio * 50);

        return Math.round(score);
    }

    private async calculateSessionConsistency(session: CodingSession): Promise<number> {
        // Get recent sessions for the same project and language
        const recentDate = new Date(session.startTime);
        recentDate.setDate(recentDate.getDate() - 7);

        const recentSessions = await this.databaseManager.getSessionsByDateRange(recentDate, session.startTime);
        const similarSessions = recentSessions.filter(
            s => s.project === session.project && s.language === session.language && s.id !== session.id
        );

        if (similarSessions.length === 0) {
            return 50; // Neutral score for new projects/languages
        }

        const avgDuration = similarSessions.reduce((sum, s) => sum + s.duration, 0) / similarSessions.length;
        const durationDiff = Math.abs(session.duration - avgDuration) / avgDuration;

        // Lower difference means higher consistency
        const consistency = Math.max(0, 100 - durationDiff * 100);

        return Math.round(consistency);
    }

    private calculateLanguageComplexity(session: CodingSession): number {
        const complexity = this.languageComplexityMap.get(session.language.toLowerCase()) || 0.5;

        // Higher complexity languages get higher scores for the same amount of work
        return Math.round(complexity * 100);
    }

    private async calculateProjectFamiliarity(session: CodingSession): Promise<number> {
        const thirtyDaysAgo = new Date(session.startTime);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const projectSessions = await this.databaseManager.getSessionsByDateRange(thirtyDaysAgo, session.startTime);
        const sameProjectSessions = projectSessions.filter(s => s.project === session.project && s.id !== session.id);

        // More sessions in the same project indicates higher familiarity
        const familiarityScore = Math.min((sameProjectSessions.length / 10) * 100, 100);

        return Math.round(familiarityScore);
    }

    private calculateTimeOfDayScore(session: CodingSession): number {
        const hour = session.startTime.getHours();

        if (this.peakProductivityHours.includes(hour)) {
            return 100;
        }

        // Calculate distance from nearest peak hour
        const distances = this.peakProductivityHours.map(peakHour => Math.abs(hour - peakHour));
        const minDistance = Math.min(...distances);

        // Score decreases with distance from peak hours
        const score = Math.max(0, 100 - minDistance * 10);

        return Math.round(score);
    }

    private calculateOverallScore(factors: ProductivityFactors): number {
        // Weighted average of all factors
        const weights = {
            keystrokeVelocity: 0.2,
            focusTime: 0.25,
            codeChurn: 0.15,
            sessionConsistency: 0.15,
            languageComplexity: 0.1,
            projectFamiliarity: 0.1,
            timeOfDay: 0.05
        };

        const weightedScore =
            factors.keystrokeVelocity * weights.keystrokeVelocity +
            factors.focusTime * weights.focusTime +
            factors.codeChurn * weights.codeChurn +
            factors.sessionConsistency * weights.sessionConsistency +
            factors.languageComplexity * weights.languageComplexity +
            factors.projectFamiliarity * weights.projectFamiliarity +
            factors.timeOfDay * weights.timeOfDay;

        return Math.min(Math.max(Math.round(weightedScore), 0), 100);
    }

    private generateInsights(factors: ProductivityFactors, session: CodingSession): string[] {
        const insights: string[] = [];

        if (factors.keystrokeVelocity < 30) {
            insights.push('Low typing velocity detected. Consider taking breaks or improving typing skills.');
        } else if (factors.keystrokeVelocity > 80) {
            insights.push('High typing velocity - great coding momentum!');
        }

        if (factors.focusTime < 50) {
            insights.push('Frequent interruptions detected. Try using focus techniques like the Pomodoro method.');
        } else if (factors.focusTime > 80) {
            insights.push('Excellent focus during this session.');
        }

        if (factors.codeChurn > 70) {
            insights.push('High code churn ratio. Most changes were additions - good progress!');
        } else if (factors.codeChurn < 30) {
            insights.push('High deletion rate. This might indicate debugging or refactoring work.');
        }

        if (factors.projectFamiliarity < 30) {
            insights.push('Working on a new or unfamiliar project. Productivity may improve as you get more familiar.');
        }

        if (!this.peakProductivityHours.includes(session.startTime.getHours())) {
            insights.push(`Coding outside peak hours (9-11 AM, 2-4 PM). Consider adjusting your schedule if possible.`);
        }

        return insights;
    }

    private generateRecommendations(factors: ProductivityFactors, session: CodingSession): string[] {
        const recommendations: string[] = [];

        if (factors.focusTime < 60) {
            recommendations.push('Use a focus timer or block distracting websites during coding sessions.');
            recommendations.push('Consider using noise-cancelling headphones or instrumental music.');
        }

        if (factors.keystrokeVelocity < 40) {
            recommendations.push('Practice typing to improve coding speed.');
            recommendations.push('Learn more keyboard shortcuts for your editor.');
        }

        if (factors.sessionConsistency < 50) {
            recommendations.push('Try to maintain consistent session lengths for better flow.');
        }

        if (factors.timeOfDay < 50) {
            recommendations.push('Consider scheduling important coding work during your peak hours (9-11 AM, 2-4 PM).');
        }

        if (session.duration < 30 * 60 * 1000) {
            // Less than 30 minutes
            recommendations.push('Longer focused sessions often lead to higher productivity.');
        }

        if (session.duration > 3 * 60 * 60 * 1000) {
            // More than 3 hours
            recommendations.push('Take regular breaks to maintain focus and prevent burnout.');
        }

        return recommendations;
    }

    private analyzeTrend(scores: number[]): { trend: 'improving' | 'declining' | 'stable'; strength: number } {
        if (scores.length < 3) {
            return { trend: 'stable', strength: 0 };
        }

        // Calculate linear regression slope
        const n = scores.length;
        const sumX = (n * (n - 1)) / 2; // Sum of indices
        const sumY = scores.reduce((a, b) => a + b, 0);
        const sumXY = scores.reduce((sum, score, index) => sum + score * index, 0);
        const sumX2 = scores.reduce((sum, _, index) => sum + index * index, 0);

        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

        // Determine trend direction and strength
        const strength = Math.abs(slope);

        if (Math.abs(slope) < 0.5) {
            return { trend: 'stable', strength };
        } else if (slope > 0) {
            return { trend: 'improving', strength };
        } else {
            return { trend: 'declining', strength };
        }
    }

    private generatePeriodInsights(sessions: any[], dailyAverages: { date: string; score: number }[]): string[] {
        const insights: string[] = [];
        const avgScore = dailyAverages.reduce((sum, day) => sum + day.score, 0) / dailyAverages.length;

        if (avgScore > 80) {
            insights.push('Excellent overall productivity during this period!');
        } else if (avgScore > 60) {
            insights.push('Good productivity levels maintained.');
        } else if (avgScore > 40) {
            insights.push('Moderate productivity. Consider implementing focus techniques.');
        } else {
            insights.push('Low productivity detected. Review your working conditions and habits.');
        }

        // Check for weekend vs weekday patterns
        const weekdayScores: number[] = [];
        const weekendScores: number[] = [];

        dailyAverages.forEach(day => {
            const date = new Date(day.date);
            const dayOfWeek = date.getDay();
            if (dayOfWeek === 0 || dayOfWeek === 6) {
                weekendScores.push(day.score);
            } else {
                weekdayScores.push(day.score);
            }
        });

        if (weekdayScores.length > 0 && weekendScores.length > 0) {
            const weekdayAvg = weekdayScores.reduce((a, b) => a + b, 0) / weekdayScores.length;
            const weekendAvg = weekendScores.reduce((a, b) => a + b, 0) / weekendScores.length;

            if (weekendAvg > weekdayAvg + 10) {
                insights.push('You tend to be more productive on weekends.');
            } else if (weekdayAvg > weekendAvg + 10) {
                insights.push('Weekday productivity is higher than weekends.');
            }
        }

        return insights;
    }
}
