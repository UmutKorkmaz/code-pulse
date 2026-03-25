// Main JavaScript file for CodePulse webview

(function() {
    'use strict';

    // VSCode API reference
    const vscode = acquireVsCodeApi();

    // State management
    let currentData = {
        currentSession: null,
        todayStats: null,
        weeklyStats: [],
        isTracking: false,
        isIdle: false,
        settings: null,
        receivedAt: Date.now()
    };

    // Chart instances
    let weeklyChart = null;

    // DOM elements
    const elements = {
        statusIndicator: document.getElementById('statusIndicator'),
        statusText: document.querySelector('.status-text'),
        statusDot: document.querySelector('.status-dot'),
        sessionTime: document.getElementById('sessionTime'),
        sessionDetails: document.getElementById('sessionDetails'),
        todayTotalTime: document.getElementById('todayTotalTime'),
        todayProductivity: document.getElementById('todayProductivity'),
        todaySessions: document.getElementById('todaySessions'),
        todayFiles: document.getElementById('todayFiles'),
        todayProjects: document.getElementById('todayProjects'),
        todayLanguages: document.getElementById('todayLanguages'),
        weeklyCanvas: document.getElementById('weeklyCanvas'),
        toggleTrackingBtn: document.getElementById('toggleTrackingBtn'),
        dashboardBtn: document.getElementById('dashboardBtn'),
        refreshBtn: document.getElementById('refreshBtn')
    };

    // Initialize the webview
    function init() {
        setupEventListeners();
        requestData();
        startPeriodicUpdates();
        
        // Show loading state
        showLoadingState();
    }

    // Setup event listeners
    function setupEventListeners() {
        // Button click handlers
        if (elements.toggleTrackingBtn) {
            elements.toggleTrackingBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'toggleTracking' });
            });
        }

        if (elements.dashboardBtn) {
            elements.dashboardBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'showDashboard' });
            });
        }

        if (elements.refreshBtn) {
            elements.refreshBtn.addEventListener('click', () => {
                refreshData();
            });
        }

        // Listen for messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            handleMessage(message);
        });

        // Session timer update
        setInterval(updateSessionTimer, 1000);
    }

    // Handle messages from the extension
    function handleMessage(message) {
        switch (message.command) {
            case 'updateData':
                updateData(message.data);
                break;
            case 'error':
                showError(message.error);
                break;
            default:
                console.log('Unknown message:', message);
        }
    }

    // Request fresh data from extension
    function requestData() {
        vscode.postMessage({ command: 'getData' });
    }

    // Refresh data
    function refreshData() {
        showLoadingState();
        vscode.postMessage({ command: 'refreshData' });
    }

    // Update the UI with new data
    function updateData(data) {
        currentData = { ...currentData, ...data, receivedAt: Date.now() };
        
        updateStatusIndicator();
        updateCurrentSession();
        updateTodayStats();
        updateQuickStats();
        updateWeeklyChart();
        
        hideLoadingState();
    }

    // Update status indicator
    function updateStatusIndicator() {
        if (!elements.statusIndicator) return;

        const { isTracking, currentSession, isIdle } = currentData;
        
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
        if (!elements.sessionTime || !elements.sessionDetails) return;

        const { currentSession, isTracking, isIdle } = currentData;
        
        if (isTracking && currentSession) {
            const duration = calculateSessionDuration(currentSession.duration, isIdle);
            elements.sessionTime.textContent = formatDuration(duration);
            
            const project = currentSession.project || 'Unknown Project';
            const language = currentSession.language || 'Unknown Language';
            const file = getShortFileName(currentSession.file);
            
            elements.sessionDetails.innerHTML = `
                <div><strong>Project:</strong> ${escapeHtml(project)}</div>
                <div><strong>Language:</strong> ${escapeHtml(language)}</div>
                <div><strong>File:</strong> ${escapeHtml(file)}</div>
                <div><strong>Status:</strong> ${isIdle ? 'Idle' : 'Active'}</div>
            `;
        } else {
            elements.sessionTime.textContent = '--:--:--';
            elements.sessionDetails.textContent = 'No active session';
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

    // Update today's stats
    function updateTodayStats() {
        const { todayStats } = currentData;
        
        if (!todayStats) return;

        if (elements.todayTotalTime) {
            elements.todayTotalTime.textContent = formatTime(todayStats.totalTime);
        }

        if (elements.todayProductivity) {
            const productivity = Math.round(todayStats.productivity?.score || 0);
            elements.todayProductivity.textContent = `${productivity}%`;
        }
    }

    // Update quick stats
    function updateQuickStats() {
        const { todayStats } = currentData;
        
        if (!todayStats) return;

        if (elements.todaySessions) {
            elements.todaySessions.textContent = String(todayStats.sessionCount || 0);
        }

        if (elements.todayFiles) {
            elements.todayFiles.textContent = Object.keys(todayStats.files).length || '0';
        }

        if (elements.todayProjects) {
            elements.todayProjects.textContent = Object.keys(todayStats.projects).length || '0';
        }

        if (elements.todayLanguages) {
            elements.todayLanguages.textContent = Object.keys(todayStats.languages).length || '0';
        }
    }

    // Update weekly chart
    function updateWeeklyChart() {
        if (!elements.weeklyCanvas || !currentData.weeklyStats) return;

        const ctx = elements.weeklyCanvas.getContext('2d');
        const weeklyData = currentData.weeklyStats;

        // Destroy existing chart
        if (weeklyChart) {
            weeklyChart.destroy();
        }

        // Prepare data
        const labels = weeklyData.map(day => {
            const date = new Date(day.date);
            return date.toLocaleDateString(undefined, { weekday: 'short' });
        });

        const data = weeklyData.map(day => Math.round(day.totalTime / (1000 * 60 * 60 * 100)) / 10); // Hours with 1 decimal

        // Chart configuration
        const config = {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Hours',
                    data: data,
                    backgroundColor: '#007acc',
                    borderColor: '#005a9e',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: 'var(--vscode-foreground)'
                        },
                        grid: {
                            color: 'var(--vscode-panel-border)'
                        }
                    },
                    x: {
                        ticks: {
                            color: 'var(--vscode-foreground)'
                        },
                        grid: {
                            display: false
                        }
                    }
                }
            }
        };

        // Create new chart
        weeklyChart = new Chart(ctx, config);
    }

    // Update session timer (real-time updates)
    function updateSessionTimer() {
        const { currentSession, isTracking, isIdle } = currentData;
        
        if (!isTracking || !currentSession || !elements.sessionTime) {
            return;
        }

        const duration = calculateSessionDuration(currentSession.duration, isIdle);
        elements.sessionTime.textContent = formatDuration(duration);
    }

    // Calculate session duration using the latest extension snapshot and local elapsed time
    function calculateSessionDuration(baseDuration, isIdle) {
        if (isIdle) {
            return baseDuration || 0;
        }

        return (baseDuration || 0) + Math.max(0, Date.now() - currentData.receivedAt);
    }

    // Format duration in milliseconds to HH:MM:SS
    function formatDuration(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        
        if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
            return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }

    // Format time in milliseconds to human readable
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

    // Get short filename from full path
    function getShortFileName(filePath) {
        if (!filePath) return 'Untitled';
        
        const fileName = filePath.split(/[/\\]/).pop() || 'Untitled';
        
        if (fileName.length > 25) {
            return fileName.substring(0, 22) + '...';
        }
        
        return fileName;
    }

    // Escape HTML to prevent XSS
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Show loading state
    function showLoadingState() {
        // Add loading class to main elements
        const loadingElements = [
            elements.sessionTime,
            elements.todayTotalTime,
            elements.todayProductivity
        ];

        loadingElements.forEach(el => {
            if (el) {
                el.textContent = '...';
                el.classList.add('loading');
            }
        });
    }

    // Hide loading state
    function hideLoadingState() {
        const loadingElements = document.querySelectorAll('.loading');
        loadingElements.forEach(el => {
            el.classList.remove('loading');
        });
    }

    // Show error message
    function showError(errorMessage) {
        // Create error notification
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error fade-in';
        errorDiv.innerHTML = `
            <strong>Error:</strong> ${escapeHtml(errorMessage)}
            <button class="btn btn-secondary" onclick="this.parentElement.remove()">×</button>
        `;
        
        // Insert at top of container
        const container = document.querySelector('.container');
        if (container) {
            container.insertBefore(errorDiv, container.firstChild);
            
            // Auto-remove after 5 seconds
            setTimeout(() => {
                if (errorDiv.parentElement) {
                    errorDiv.remove();
                }
            }, 5000);
        }
    }

    // Start periodic updates
    function startPeriodicUpdates() {
        // Request fresh data every 30 seconds
        setInterval(() => {
            requestData();
        }, 30000);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', function(event) {
        // Ctrl/Cmd + R: Refresh
        if ((event.ctrlKey || event.metaKey) && event.key === 'r') {
            event.preventDefault();
            refreshData();
        }
        
        // Space: Toggle tracking
        if (event.code === 'Space' && !event.target.matches('input, textarea, button')) {
            event.preventDefault();
            vscode.postMessage({ command: 'toggleTracking' });
        }
    });

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', function() {
        if (weeklyChart) {
            weeklyChart.destroy();
        }
    });

})();
