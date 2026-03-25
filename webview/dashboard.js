// Dashboard JavaScript for CodePulse

(function() {
    'use strict';

    // VSCode API reference
    const vscode = acquireVsCodeApi();

    // Global state
    let dashboardData = {
        currentSession: null,
        todayStats: null,
        weeklyStats: [],
        sessions: [],
        activities: [],
        projectStats: {},
        languageStats: {},
        isTracking: false,
        isIdle: false,
        settings: null,
        receivedAt: Date.now()
    };

    // Chart instances
    let charts = {
        weekly: null,
        projects: null,
        languages: null
    };

    // DOM elements cache
    const elements = {};

    // Initialize dashboard
    function init() {
        cacheElements();
        setupEventListeners();
        requestFullData();
        startPeriodicUpdates();
        showLoadingState();
    }

    // Cache frequently used DOM elements
    function cacheElements() {
        const elementIds = [
            'statusIndicator', 'sessionTimer', 'sessionInfo', 'todayTotalTime',
            'todayActiveTime', 'todayProductivity', 'todaySessions', 'toggleTrackingBtn',
            'weeklyChart', 'projectChart', 'languageChart', 'projectList',
            'languageList', 'activityList'
        ];

        elementIds.forEach(id => {
            elements[id] = document.getElementById(id);
        });

        // Cache by class name
        elements.statusDot = document.querySelector('.status-dot');
        elements.statusText = document.querySelector('.status-text');
    }

    // Setup event listeners
    function setupEventListeners() {
        // Toggle tracking button
        if (elements.toggleTrackingBtn) {
            elements.toggleTrackingBtn.addEventListener('click', toggleTracking);
        }

        // Listen for messages from extension
        window.addEventListener('message', handleMessage);

        // Keyboard shortcuts
        document.addEventListener('keydown', handleKeyboard);

        // Chart resize handling
        window.addEventListener('resize', debounce(resizeCharts, 300));
    }

    // Handle messages from extension
    function handleMessage(event) {
        const message = event.data;
        
        switch (message.command) {
            case 'updateFullData':
                updateDashboardData(message.data);
                break;
            case 'updateDateRangeData':
                updateDateRangeData(message.data);
                break;
            case 'updateProjectStats':
                updateProjectStats(message.data);
                break;
            case 'updateLanguageStats':
                updateLanguageStats(message.data);
                break;
            case 'error':
                showError(message.error);
                break;
            default:
                console.log('Unknown message:', message);
        }
    }

    // Handle keyboard shortcuts
    function handleKeyboard(event) {
        // Ctrl/Cmd + R: Refresh
        if ((event.ctrlKey || event.metaKey) && event.key === 'r') {
            event.preventDefault();
            refreshDashboard();
        }
        
        // Space: Toggle tracking
        if (event.code === 'Space' && !event.target.matches('input, textarea, button, select')) {
            event.preventDefault();
            toggleTracking();
        }
        
        // Escape: Focus management
        if (event.key === 'Escape') {
            document.activeElement.blur();
        }
    }

    // Request full dashboard data
    function requestFullData() {
        vscode.postMessage({ 
            command: 'getFullData',
            webview: true
        });
    }

    // Refresh dashboard
    function refreshDashboard() {
        showLoadingState();
        requestFullData();
    }

    // Toggle time tracking
    function toggleTracking() {
        vscode.postMessage({ command: 'toggleTracking' });
        
        // Provide immediate feedback
        if (elements.toggleTrackingBtn) {
            elements.toggleTrackingBtn.disabled = true;
            setTimeout(() => {
                elements.toggleTrackingBtn.disabled = false;
            }, 1000);
        }
    }

    // Update dashboard with new data
    function updateDashboardData(data) {
        dashboardData = { ...dashboardData, ...data, receivedAt: Date.now() };
        
        updateStatusIndicator();
        updateCurrentSession();
        updateTodayStats();
        updateWeeklyChart();
        updateProjectChart();
        updateLanguageChart();
        updateActivityList();
        
        hideLoadingState();
    }

    function updateDateRangeData(data) {
        dashboardData = { ...dashboardData, ...data };
        updateProjectChart();
        updateLanguageChart();
        updateActivityList();
    }

    function updateProjectStats(data) {
        dashboardData.projectStats = data;
        updateProjectChart();
    }

    function updateLanguageStats(data) {
        dashboardData.languageStats = data;
        updateLanguageChart();
    }

    // Update status indicator
    function updateStatusIndicator() {
        const { isTracking, currentSession, isIdle } = dashboardData;
        
        if (!elements.statusDot || !elements.statusText) return;

        if (isTracking && currentSession) {
            elements.statusDot.className = `status-dot ${isIdle ? '' : 'active'}`.trim();
            elements.statusText.textContent = isIdle ? 'Idle' : 'Tracking Active';
        } else {
            elements.statusDot.className = 'status-dot';
            elements.statusText.textContent = 'Not Tracking';
        }
    }

    // Update current session display
    function updateCurrentSession() {
        const { currentSession, isTracking, isIdle } = dashboardData;
        
        if (!elements.sessionTimer || !elements.sessionInfo) return;

        if (isTracking && currentSession) {
            updateSessionTimer();
            
            const project = currentSession.project || 'Unknown Project';
            const language = currentSession.language || 'Unknown Language';
            const file = getShortFileName(currentSession.file);
            const productivity = currentSession.productivityScore 
                ? Math.round(currentSession.productivityScore) + '%' 
                : 'Calculating...';

            elements.sessionInfo.innerHTML = `
                <div><strong>Project:</strong> ${escapeHtml(project)}</div>
                <div><strong>Language:</strong> ${escapeHtml(language)}</div>
                <div><strong>File:</strong> ${escapeHtml(file)}</div>
                <div><strong>Status:</strong> ${isIdle ? 'Idle' : 'Active'}</div>
                <div><strong>Productivity:</strong> ${productivity}</div>
                <div><strong>Heartbeats:</strong> ${currentSession.heartbeats || 0}</div>
                <div><strong>Keystrokes:</strong> ${currentSession.keystrokes || 0}</div>
            `;
        } else {
            elements.sessionTimer.textContent = '--:--:--';
            elements.sessionInfo.innerHTML = '<div>No active session</div>';
        }

        // Update tracking button
        if (elements.toggleTrackingBtn) {
            if (isTracking) {
                elements.toggleTrackingBtn.textContent = 'Stop Tracking';
                elements.toggleTrackingBtn.className = 'btn btn-warning';
            } else {
                elements.toggleTrackingBtn.textContent = 'Start Tracking';
                elements.toggleTrackingBtn.className = 'btn btn-primary';
            }
        }
    }

    // Update session timer (real-time)
    function updateSessionTimer() {
        const { currentSession, isTracking, isIdle } = dashboardData;
        
        if (!isTracking || !currentSession || !elements.sessionTimer) return;

        const duration = calculateSessionDuration(currentSession.duration, isIdle);
        elements.sessionTimer.textContent = formatDuration(duration);
    }

    // Update today's stats
    function updateTodayStats() {
        const { todayStats } = dashboardData;
        
        if (!todayStats) return;

        if (elements.todayTotalTime) {
            elements.todayTotalTime.textContent = formatTime(todayStats.totalTime);
        }

        if (elements.todayActiveTime) {
            elements.todayActiveTime.textContent = formatTime(todayStats.activeTime);
        }

        if (elements.todayProductivity) {
            const productivity = Math.round(todayStats.productivity?.score || 0);
            elements.todayProductivity.textContent = `${productivity}%`;
        }

        if (elements.todaySessions) {
            elements.todaySessions.textContent = String(todayStats.sessionCount || 0);
        }
    }

    // Update weekly chart
    function updateWeeklyChart() {
        if (!elements.weeklyChart || !dashboardData.weeklyStats) return;

        const ctx = elements.weeklyChart.getContext('2d');
        
        if (charts.weekly) {
            charts.weekly.destroy();
        }

        const weeklyData = dashboardData.weeklyStats;
        const labels = weeklyData.map(day => {
            const date = new Date(day.date);
            return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        });

        const totalTimeData = weeklyData.map(day => 
            Math.round(day.totalTime / (1000 * 60 * 60) * 10) / 10
        );

        const productivityData = weeklyData.map(day => 
            Math.round(day.productivity?.score || 0)
        );

        charts.weekly = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Hours',
                    data: totalTimeData,
                    borderColor: '#007acc',
                    backgroundColor: 'rgba(0, 122, 204, 0.1)',
                    tension: 0.4,
                    yAxisID: 'y'
                }, {
                    label: 'Productivity %',
                    data: productivityData,
                    borderColor: '#00d4ff',
                    backgroundColor: 'rgba(0, 212, 255, 0.1)',
                    tension: 0.4,
                    yAxisID: 'y1'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: {
                    x: {
                        display: true,
                        ticks: { color: 'var(--vscode-foreground)' },
                        grid: { color: 'var(--vscode-panel-border)' }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        title: { display: true, text: 'Hours', color: 'var(--vscode-foreground)' },
                        ticks: { color: 'var(--vscode-foreground)' },
                        grid: { color: 'var(--vscode-panel-border)' }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        title: { display: true, text: 'Productivity %', color: 'var(--vscode-foreground)' },
                        ticks: { color: 'var(--vscode-foreground)' },
                        grid: { drawOnChartArea: false, color: 'var(--vscode-panel-border)' }
                    }
                },
                plugins: {
                    legend: {
                        labels: { color: 'var(--vscode-foreground)' }
                    },
                    tooltip: {
                        backgroundColor: 'var(--vscode-sideBar-background)',
                        titleColor: 'var(--vscode-foreground)',
                        bodyColor: 'var(--vscode-foreground)',
                        borderColor: 'var(--vscode-panel-border)',
                        borderWidth: 1
                    }
                }
            }
        });
    }

    // Update project chart
    function updateProjectChart() {
        if (!elements.projectChart || !dashboardData.projectStats) return;

        const ctx = elements.projectChart.getContext('2d');
        
        if (charts.projects) {
            charts.projects.destroy();
        }

        const projectData = Object.entries(dashboardData.projectStats);
        if (projectData.length === 0) {
            showEmptyChart(elements.projectChart, 'No project data available');
            return;
        }

        // Sort and take top 10
        const topProjects = projectData
            .sort(([,a], [,b]) => b - a)
            .slice(0, 10);

        const labels = topProjects.map(([name]) => name);
        const data = topProjects.map(([,time]) => Math.round(time / (1000 * 60 * 60) * 10) / 10);
        const colors = generateColors(labels.length);

        charts.projects = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: colors,
                    borderColor: 'var(--vscode-panel-border)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { 
                            color: 'var(--vscode-foreground)',
                            usePointStyle: true,
                            padding: 15
                        }
                    },
                    tooltip: {
                        backgroundColor: 'var(--vscode-sideBar-background)',
                        titleColor: 'var(--vscode-foreground)',
                        bodyColor: 'var(--vscode-foreground)',
                        borderColor: 'var(--vscode-panel-border)',
                        borderWidth: 1,
                        callbacks: {
                            label: function(context) {
                                return `${context.label}: ${context.parsed}h`;
                            }
                        }
                    }
                }
            }
        });

        // Update project list
        updateProjectList(topProjects);
    }

    // Update language chart
    function updateLanguageChart() {
        if (!elements.languageChart || !dashboardData.languageStats) return;

        const ctx = elements.languageChart.getContext('2d');
        
        if (charts.languages) {
            charts.languages.destroy();
        }

        const languageData = Object.entries(dashboardData.languageStats);
        if (languageData.length === 0) {
            showEmptyChart(elements.languageChart, 'No language data available');
            return;
        }

        // Sort and take top 10
        const topLanguages = languageData
            .sort(([,a], [,b]) => b - a)
            .slice(0, 10);

        const labels = topLanguages.map(([name]) => name);
        const data = topLanguages.map(([,time]) => Math.round(time / (1000 * 60 * 60) * 10) / 10);
        const colors = generateColors(labels.length, 180); // Different hue offset

        charts.languages = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: colors,
                    borderColor: 'var(--vscode-panel-border)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { 
                            color: 'var(--vscode-foreground)',
                            usePointStyle: true,
                            padding: 15
                        }
                    },
                    tooltip: {
                        backgroundColor: 'var(--vscode-sideBar-background)',
                        titleColor: 'var(--vscode-foreground)',
                        bodyColor: 'var(--vscode-foreground)',
                        borderColor: 'var(--vscode-panel-border)',
                        borderWidth: 1,
                        callbacks: {
                            label: function(context) {
                                return `${context.label}: ${context.parsed}h`;
                            }
                        }
                    }
                }
            }
        });

        // Update language list
        updateLanguageList(topLanguages);
    }

    // Update project list
    function updateProjectList(projects) {
        if (!elements.projectList) return;

        const totalTime = projects.reduce((sum, [,time]) => sum + time, 0);
        
        elements.projectList.innerHTML = projects.map(([name, time]) => {
            const hours = Math.round(time / (1000 * 60 * 60) * 10) / 10;
            const percentage = Math.round((time / totalTime) * 100);
            
            return `
                <div class="breakdown-item">
                    <div class="breakdown-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                    <div class="breakdown-time">${hours}h</div>
                    <div class="breakdown-percentage">${percentage}%</div>
                </div>
            `;
        }).join('');
    }

    // Update language list
    function updateLanguageList(languages) {
        if (!elements.languageList) return;

        const totalTime = languages.reduce((sum, [,time]) => sum + time, 0);
        
        elements.languageList.innerHTML = languages.map(([name, time]) => {
            const hours = Math.round(time / (1000 * 60 * 60) * 10) / 10;
            const percentage = Math.round((time / totalTime) * 100);
            
            return `
                <div class="breakdown-item">
                    <div class="breakdown-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                    <div class="breakdown-time">${hours}h</div>
                    <div class="breakdown-percentage">${percentage}%</div>
                </div>
            `;
        }).join('');
    }

    // Update activity list
    function updateActivityList() {
        if (!elements.activityList) return;

        const recentActivities = (dashboardData.activities || []).slice(-10).reverse();
        if (recentActivities.length === 0) {
            elements.activityList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📊</div>
                    <div class="empty-state-title">No Recent Activity</div>
                    <div class="empty-state-description">Start coding to see your activity here.</div>
                </div>
            `;
            return;
        }

        elements.activityList.innerHTML = recentActivities.map(activity => {
            const timestamp = new Date(activity.timestamp);
            const project = activity.project || 'Unknown Project';
            const language = activity.language || 'Unknown';
            const file = getShortFileName(activity.file);
            
            return `
                <div class="activity-item">
                    <div class="activity-time">${timestamp.toLocaleTimeString(undefined, { 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    })}</div>
                    <div class="activity-description">
                        <div><strong>${escapeHtml(project)}</strong> - ${escapeHtml(language)}</div>
                        <div class="activity-meta">${escapeHtml(activity.type)} • ${escapeHtml(file)}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    // Utility functions
    function calculateSessionDuration(baseDuration, isIdle) {
        if (isIdle) {
            return baseDuration || 0;
        }

        return (baseDuration || 0) + Math.max(0, Date.now() - dashboardData.receivedAt);
    }

    function formatDuration(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    function formatTime(ms) {
        const totalMinutes = Math.floor(ms / (1000 * 60));
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        
        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else {
            return `${minutes}m`;
        }
    }

    function getShortFileName(filePath) {
        if (!filePath) return 'Untitled';
        
        const fileName = filePath.split(/[/\\]/).pop() || 'Untitled';
        return fileName.length > 30 ? fileName.substring(0, 27) + '...' : fileName;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function generateColors(count, hueOffset = 0) {
        const colors = [];
        for (let i = 0; i < count; i++) {
            const hue = (i * 360 / count + hueOffset) % 360;
            colors.push(`hsl(${hue}, 70%, 60%)`);
        }
        return colors;
    }

    function showEmptyChart(canvas, message) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'var(--vscode-descriptionForeground)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '14px var(--vscode-font-family)';
        ctx.fillText(message, canvas.width / 2, canvas.height / 2);
    }

    function showLoadingState() {
        const loadingElements = [
            elements.sessionTimer,
            elements.todayTotalTime,
            elements.todayActiveTime,
            elements.todayProductivity
        ];

        loadingElements.forEach(el => {
            if (el) {
                el.textContent = '...';
                el.classList.add('skeleton');
            }
        });
    }

    function hideLoadingState() {
        const loadingElements = document.querySelectorAll('.skeleton');
        loadingElements.forEach(el => {
            el.classList.remove('skeleton');
        });
    }

    function showError(message) {
        // Implementation similar to main.js
        console.error('Dashboard error:', message);
    }

    function resizeCharts() {
        Object.values(charts).forEach(chart => {
            if (chart) {
                chart.resize();
            }
        });
    }

    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    function startPeriodicUpdates() {
        // Update session timer every second
        setInterval(updateSessionTimer, 1000);
        
        // Refresh data every 60 seconds
        setInterval(requestFullData, 60000);
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', function() {
        Object.values(charts).forEach(chart => {
            if (chart) {
                chart.destroy();
            }
        });
    });

})();
