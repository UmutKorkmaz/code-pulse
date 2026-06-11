// Dashboard JavaScript for CodePulse

(function () {
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
    activeTagFilter: null,
    settings: null,
    sessionsLookup: {},
    goalProgress: null,
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
    requestAllSessions(30);
    requestWindowSessions(30);
    setupSessionsTable();
    startPeriodicUpdates();
    showLoadingState();
  }

  // --- Sessions table state ---
  // All user-derived strings pass through escapeHtml() before entering innerHTML.
  const sessionsState = {
    raw: [],
    filtered: [],
    page: 0,
    pageSize: 50,
    sortKey: 'startTime',
    sortDir: 'desc',
    filters: { search: '', project: '', language: '', tag: '', days: 30 }
  };

  function requestAllSessions(days) {
    vscode.postMessage({ command: 'getAllSessions', days });
  }

  function requestWindowSessions(days) {
    const end = new Date();
    const start = new Date();
    if (days > 0) {
      start.setDate(end.getDate() - days);
    } else {
      start.setFullYear(2000, 0, 1);
    }

    vscode.postMessage({
      command: 'getDateRangeData',
      startDate: start.toISOString(),
      endDate: end.toISOString()
    });
  }

  function updateAllSessions(payload) {
    sessionsState.raw = payload.sessions || [];
    populateFilterOptions();
    applySessionsFilters();
  }

  function populateFilterOptions() {
    const projects = new Set(),
      languages = new Set(),
      tags = new Set();
    sessionsState.raw.forEach(s => {
      if (s.project) projects.add(s.project);
      if (s.language) languages.add(s.language);
      getSessionTags(s).forEach(tag => tags.add(tag));
    });
    const projSel = document.getElementById('sessionProjectFilter');
    const langSel = document.getElementById('sessionLanguageFilter');
    const tagSel = document.getElementById('sessionTagFilter');
    const activeTag = sessionsState.filters.tag || '';
    if (projSel) {
      const current = projSel.value;
      projSel.innerHTML =
        '<option value="">All projects</option>' +
        [...projects]
          .sort()
          .map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
          .join('');
      projSel.value = current;
    }
    if (langSel) {
      const current = langSel.value;
      langSel.innerHTML =
        '<option value="">All languages</option>' +
        [...languages]
          .sort()
          .map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`)
          .join('');
      langSel.value = current;
    }
    if (tagSel) {
      const current = tagSel.value || activeTag;
      const ordered = [...tags].sort();
      tagSel.innerHTML =
        '<option value="">All tags</option>' +
        ordered.map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('');
      if (current && ordered.indexOf(current) === -1) {
        tagSel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(current)}">${escapeHtml(current)}</option>`);
      }
      tagSel.value = current;
    }
  }

  function applySessionsFilters() {
    const { search, project, language, tag } = sessionsState.filters;
    const q = search.toLowerCase().trim();
    const normalizedTag = normalizeTag(tag);
    sessionsState.filtered = sessionsState.raw.filter(s => {
      if (project && s.project !== project) return false;
      if (language && s.language !== language) return false;
      if (normalizedTag) {
        const sessionTags = new Set(getSessionTags(s));
        if (!sessionTags.has(normalizedTag)) return false;
      }
      if (q) {
        const hay = `${s.file || ''} ${s.branch || ''} ${s.project || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    sortSessions();
    sessionsState.page = 0;
    renderSessionsTable();
    updateActivityList();
  }

  function sortSessions() {
    const { sortKey, sortDir } = sessionsState;
    const dir = sortDir === 'asc' ? 1 : -1;
    sessionsState.filtered.sort((a, b) => {
      let av = a[sortKey],
        bv = b[sortKey];
      if (sortKey === 'startTime') {
        av = new Date(av).getTime();
        bv = new Date(bv).getTime();
      }
      if (sortKey === 'tags') {
        av = getSessionTagSummary(a);
        bv = getSessionTagSummary(b);
      }
      if (typeof av === 'string') return av.localeCompare(bv || '') * dir;
      return ((av || 0) - (bv || 0)) * dir;
    });
  }

  function renderSessionsTable() {
    const tbody = document.getElementById('sessionsTableBody');
    const countEl = document.getElementById('sessionsCount');
    const pageInfo = document.getElementById('sessionPageInfo');
    if (!tbody) return;

    const total = sessionsState.filtered.length;
    const { page, pageSize } = sessionsState;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const start = page * pageSize;
    const rows = sessionsState.filtered.slice(start, start + pageSize);

    if (countEl) countEl.textContent = `${total.toLocaleString()} session${total === 1 ? '' : 's'}`;
    if (pageInfo) pageInfo.textContent = `Page ${page + 1} of ${pages}`;

    const prevBtn = document.getElementById('sessionPrevBtn');
    const nextBtn = document.getElementById('sessionNextBtn');
    if (prevBtn) prevBtn.disabled = page === 0;
    if (nextBtn) nextBtn.disabled = page >= pages - 1;

    if (rows.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="8" class="loading-cell">No sessions match your filters</td></tr>';
      return;
    }

    tbody.innerHTML = rows
      .map(s => {
        const dt = new Date(s.startTime);
        const dateStr = dt.toLocaleDateString(undefined, {
          year: '2-digit',
          month: 'short',
          day: 'numeric'
        });
        const timeStr = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const durMin = Math.round((s.duration || 0) / 60000);
        const durStr = durMin >= 60 ? `${Math.floor(durMin / 60)}h ${durMin % 60}m` : `${durMin}m`;
        const fileName = (s.file || '').split(/[/\\]/).pop() || '—';
        const score = Math.round(s.productivityScore || 0);
        const scoreClass = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
        const tags = getSessionTags(s).map(tag => `<span class="tag-pill">${escapeHtml(tag)}</span>`).join(' ');

        return `
        <tr>
          <td>
            <div>${escapeHtml(dateStr)}</div>
            <div class="muted" style="font-size:10px">${escapeHtml(timeStr)}</div>
          </td>
          <td>${escapeHtml(s.project || '—')}</td>
          <td><span class="lang-pill">${escapeHtml(s.language || '—')}</span></td>
          <td class="file-cell" title="${escapeHtml(s.file || '')}">${escapeHtml(fileName)}</td>
          <td class="tags-cell">${tags || '—'}</td>
          <td class="muted">${escapeHtml(s.branch || '—')}</td>
          <td class="num">${escapeHtml(durStr)}</td>
          <td class="num">
            <div class="score-bar">
              <span>${score}</span>
              <span class="score-bar-track"><span class="score-bar-fill ${scoreClass}" style="width:${score}%"></span></span>
            </div>
          </td>
        </tr>`;
      })
      .join('');
  }

  function setupSessionsTable() {
    const search = document.getElementById('sessionSearch');
    const proj = document.getElementById('sessionProjectFilter');
    const lang = document.getElementById('sessionLanguageFilter');
    const tag = document.getElementById('sessionTagFilter');
    const range = document.getElementById('sessionDateRange');
    const clear = document.getElementById('sessionClearBtn');
    const prev = document.getElementById('sessionPrevBtn');
    const next = document.getElementById('sessionNextBtn');
    const quickCommand = document.getElementById('quickCommandInput');
    const quickCommandBtn = document.getElementById('quickCommandBtn');

    if (search)
      search.addEventListener(
        'input',
        debounce(e => {
          sessionsState.filters.search = e.target.value;
          applySessionsFilters();
        }, 200)
      );

    if (proj)
      proj.addEventListener('change', e => {
        sessionsState.filters.project = e.target.value;
        applySessionsFilters();
      });

    if (lang)
      lang.addEventListener('change', e => {
        sessionsState.filters.language = e.target.value;
        applySessionsFilters();
      });

    if (tag)
      tag.addEventListener('change', e => {
        syncTagFilterFromDashboard(e.target.value);
      });

    if (quickCommandBtn)
      quickCommandBtn.addEventListener('click', () => {
        runQuickCommand(quickCommand ? quickCommand.value : '');
      });

    if (quickCommand)
      quickCommand.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          runQuickCommand(e.target.value);
        }
      });

    if (range)
      range.addEventListener('change', e => {
        const days = parseInt(e.target.value, 10);
        sessionsState.filters.days = days;
        requestAllSessions(days);
        requestWindowSessions(days);
      });

    if (clear)
      clear.addEventListener('click', () => {
        sessionsState.filters = { search: '', project: '', language: '', tag: '', days: 30 };
        if (search) search.value = '';
        if (proj) proj.value = '';
        if (lang) lang.value = '';
        if (tag) tag.value = '';
        if (range) range.value = '30';
        vscode.postMessage({ command: 'filterByTag', tag: null });
        requestAllSessions(30);
        requestWindowSessions(30);
      });

    if (prev)
      prev.addEventListener('click', () => {
        if (sessionsState.page > 0) {
          sessionsState.page--;
          renderSessionsTable();
        }
      });

    if (next)
      next.addEventListener('click', () => {
        const pages = Math.ceil(sessionsState.filtered.length / sessionsState.pageSize);
        if (sessionsState.page < pages - 1) {
          sessionsState.page++;
          renderSessionsTable();
        }
      });

    document.querySelectorAll('.sessions-table th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (sessionsState.sortKey === key) {
          sessionsState.sortDir = sessionsState.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sessionsState.sortKey = key;
          sessionsState.sortDir = key === 'startTime' ? 'desc' : 'asc';
        }
        document.querySelectorAll('.sessions-table th').forEach(h => {
          h.classList.remove('sort-asc', 'sort-desc');
        });
        th.classList.add(sessionsState.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
        sortSessions();
        renderSessionsTable();
      });
    });

    const defaultTh = document.querySelector('.sessions-table th[data-sort="startTime"]');
    if (defaultTh) defaultTh.classList.add('sort-desc');
  }

  // Cache frequently used DOM elements
  function cacheElements() {
    const elementIds = [
      'statusIndicator',
      'sessionTimer',
      'sessionInfo',
      'todayTotalTime',
      'todayActiveTime',
      'todayProductivity',
      'todaySessions',
      'goalProjectName',
      'globalDailyGoal',
      'globalWeeklyGoal',
      'projectDailyGoal',
      'projectWeeklyGoal',
      'toggleTrackingBtn',
      'weeklyChart',
      'projectChart',
      'languageChart',
      'projectList',
      'languageList',
      'activityList',
      'aiToolsList',
      'aiExtensionsList',
      'aiOfflineHint'
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
      case 'setLocalTagFilter':
        applyLocalTagFilter(message.data?.tag);
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
      case 'updateAllSessions':
        updateAllSessions(message.data);
        break;
      case 'updateAiData':
        updateAiTools(message.data);
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
    requestWindowSessions(sessionsState.filters.days);
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
    applyLocalTagFilter(data.activeTagFilter);

    updateStatusIndicator();
    updateCurrentSession();
    updateTodayStats();
    updateGoalCards();
    updateWeeklyChart();
    updateProjectChart();
    updateLanguageChart();
    updateActivityList();

    hideLoadingState();
  }

  function updateDateRangeData(data) {
    dashboardData = { ...dashboardData, ...data };
    if (Array.isArray(data.sessions)) {
      sessionsState.raw = data.sessions;
      populateFilterOptions();
      applyLocalTagFilter(data.tagFilter);
    }
    if (data.projectStats) {
      dashboardData.projectStats = data.projectStats;
    }
    if (data.languageStats) {
      dashboardData.languageStats = data.languageStats;
    }
    if (data.dateRange) {
      dashboardData.dateRange = data.dateRange;
    }
    applyLocalTagFilter(data.tagFilter);
    updateProjectChart();
    updateLanguageChart();
    syncActivitiesCache();
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
      const tagPills = getSessionTags(currentSession)
        .map(tag => `<span class="tag-pill">${escapeHtml(tag)}</span>`)
        .join(' ');

      elements.sessionInfo.innerHTML = `
                <div><strong>Project:</strong> ${escapeHtml(project)}</div>
                <div><strong>Language:</strong> ${escapeHtml(language)}</div>
                <div><strong>File:</strong> ${escapeHtml(file)}</div>
                <div><strong>Status:</strong> ${isIdle ? 'Idle' : 'Active'}</div>
                <div><strong>Productivity:</strong> ${productivity}</div>
                <div><strong>Heartbeats:</strong> ${currentSession.heartbeats || 0}</div>
                <div><strong>Keystrokes:</strong> ${currentSession.keystrokes || 0}</div>
                <div><strong>Tags:</strong> ${tagPills || '—'}</div>
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

  // Update goal progress cards
  function updateGoalCards() {
    const goalData = dashboardData.goalProgress;
    if (!goalData) {
      hideGoalPanels();
      return;
    }

    if (elements.goalProjectName) {
      elements.goalProjectName.textContent = goalData.project?.projectName || 'No project selected';
    }

    const hasGlobalDaily = goalData.global?.daily?.isGoalSet;
    const hasGlobalWeekly = goalData.global?.weekly?.isGoalSet;
    const hasProjectDaily = goalData.project?.daily?.isGoalSet;
    const hasProjectWeekly = goalData.project?.weekly?.isGoalSet;

    if (elements.globalDailyGoal) {
      renderGoalMetric(elements.globalDailyGoal, goalData.global?.daily, hasGlobalDaily);
    }

    if (elements.globalWeeklyGoal) {
      renderGoalMetric(elements.globalWeeklyGoal, goalData.global?.weekly, hasGlobalWeekly);
    }

    if (elements.projectDailyGoal) {
      renderGoalMetric(elements.projectDailyGoal, goalData.project?.daily, hasProjectDaily);
    }

    if (elements.projectWeeklyGoal) {
      renderGoalMetric(elements.projectWeeklyGoal, goalData.project?.weekly, hasProjectWeekly);
    }
  }

  function renderGoalMetric(element, metric, isSet) {
    if (!element) {
      return;
    }

    const valueEl = element.querySelector('.goal-metric-value');
    const detailEl = element.querySelector('.goal-metric-detail');
    if (!valueEl || !detailEl) {
      return;
    }

    if (!metric || !isSet) {
      valueEl.textContent = 'Not set';
      detailEl.textContent = 'No target';
      element.classList.remove('goal-on-track', 'goal-complete');
      return;
    }

    const pct = Math.min(100, Math.max(0, Math.round(metric.percent || 0)));
    const remainText = formatGoalMinutes(metric.remainingMinutes || 0);
    const etaText = metric.etaAt ? `ETA ${formatGoalEta(metric.etaAt)}` : 'ETA unavailable';

    valueEl.textContent = `${pct}%`;
    detailEl.textContent = `${remainText} remaining • ${etaText}`;
    element.classList.remove('goal-on-track', 'goal-complete');

    if (pct >= 100) {
      element.classList.add('goal-complete');
    } else if (pct >= 75) {
      element.classList.add('goal-on-track');
    }
  }

  function hideGoalPanels() {
    const cards = [elements.globalDailyGoal, elements.globalWeeklyGoal, elements.projectDailyGoal, elements.projectWeeklyGoal];
    cards.forEach(card => {
      if (!card) {
        return;
      }
      const valueEl = card.querySelector('.goal-metric-value');
      const detailEl = card.querySelector('.goal-metric-detail');
      if (valueEl) valueEl.textContent = 'Not set';
      if (detailEl) detailEl.textContent = 'No target';
      card.classList.remove('goal-on-track', 'goal-complete');
    });

    if (elements.goalProjectName) {
      elements.goalProjectName.textContent = 'No project selected';
    }
  }

  function formatGoalMinutes(totalMinutes) {
    const total = Math.max(0, Math.round(totalMinutes));
    const hours = Math.floor(total / 60);
    const mins = total % 60;

    if (hours > 0) {
      return `${hours}h ${mins}m`;
    }

    return `${mins}m`;
  }

  function formatGoalEta(timestampMs) {
    const d = new Date(timestampMs);
    return d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // Resolve CSS variable to actual color value for canvas rendering
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  // Update weekly chart
  function updateWeeklyChart() {
    if (!elements.weeklyChart || !dashboardData.weeklyStats) return;

    const ctx = elements.weeklyChart.getContext('2d');

    if (charts.weekly) {
      charts.weekly.destroy();
    }

    const fg = cssVar('--vscode-foreground');
    const border = cssVar('--vscode-panel-border');
    const bg = cssVar('--vscode-sideBar-background');

    const weeklyData = dashboardData.weeklyStats;
    const labels = weeklyData.map(day => {
      const date = new Date(day.date);
      return date.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      });
    });

    const totalTimeData = weeklyData.map(
      day => Math.round((day.totalTime / (1000 * 60 * 60)) * 10) / 10
    );

    const productivityData = weeklyData.map(day => Math.round(day.productivity?.score || 0));

    charts.weekly = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Hours',
            data: totalTimeData,
            borderColor: '#007acc',
            backgroundColor: 'rgba(0, 122, 204, 0.1)',
            tension: 0.4,
            yAxisID: 'y'
          },
          {
            label: 'Productivity %',
            data: productivityData,
            borderColor: '#00d4ff',
            backgroundColor: 'rgba(0, 212, 255, 0.1)',
            tension: 0.4,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        scales: {
          x: {
            display: true,
            ticks: { color: fg },
            grid: { color: border }
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            title: { display: true, text: 'Hours', color: fg },
            ticks: { color: fg },
            grid: { color: border }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            title: { display: true, text: 'Productivity %', color: fg },
            ticks: { color: fg },
            grid: { drawOnChartArea: false, color: border }
          }
        },
        plugins: {
          legend: {
            labels: { color: fg }
          },
          tooltip: {
            backgroundColor: bg,
            titleColor: fg,
            bodyColor: fg,
            borderColor: border,
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
    const topProjects = projectData.sort(([, a], [, b]) => b - a).slice(0, 10);

    const labels = topProjects.map(([name]) => name);
    const data = topProjects.map(([, time]) => Math.round((time / (1000 * 60 * 60)) * 10) / 10);
    const colors = generateColors(labels.length);

    const fg = cssVar('--vscode-foreground');
    const border = cssVar('--vscode-panel-border');
    const bg = cssVar('--vscode-sideBar-background');

    charts.projects = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            backgroundColor: colors,
            borderColor: border,
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: fg, usePointStyle: true, padding: 15 }
          },
          tooltip: {
            backgroundColor: bg,
            titleColor: fg,
            bodyColor: fg,
            borderColor: border,
            borderWidth: 1,
            callbacks: {
              label: function (context) {
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
    const topLanguages = languageData.sort(([, a], [, b]) => b - a).slice(0, 10);

    const labels = topLanguages.map(([name]) => name);
    const data = topLanguages.map(([, time]) => Math.round((time / (1000 * 60 * 60)) * 10) / 10);
    const colors = generateColors(labels.length, 180);

    const fg2 = cssVar('--vscode-foreground');
    const border2 = cssVar('--vscode-panel-border');
    const bg2 = cssVar('--vscode-sideBar-background');

    charts.languages = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            backgroundColor: colors,
            borderColor: border2,
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: fg2, usePointStyle: true, padding: 15 }
          },
          tooltip: {
            backgroundColor: bg2,
            titleColor: fg2,
            bodyColor: fg2,
            borderColor: border2,
            borderWidth: 1,
            callbacks: {
              label: function (context) {
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

    const totalTime = projects.reduce((sum, [, time]) => sum + time, 0);

    elements.projectList.innerHTML = projects
      .map(([name, time]) => {
        const hours = Math.round((time / (1000 * 60 * 60)) * 10) / 10;
        const percentage = Math.round((time / totalTime) * 100);

        return `
                <div class="breakdown-item">
                    <div class="breakdown-name" title="${escapeHtml(name)}">${escapeHtml(
          name
        )}</div>
                    <div class="breakdown-time">${hours}h</div>
                    <div class="breakdown-percentage">${percentage}%</div>
                </div>
            `;
      })
      .join('');
  }

  // Update language list
  function updateLanguageList(languages) {
    if (!elements.languageList) return;

    const totalTime = languages.reduce((sum, [, time]) => sum + time, 0);

    elements.languageList.innerHTML = languages
      .map(([name, time]) => {
        const hours = Math.round((time / (1000 * 60 * 60)) * 10) / 10;
        const percentage = Math.round((time / totalTime) * 100);

        return `
                <div class="breakdown-item">
                    <div class="breakdown-name" title="${escapeHtml(name)}">${escapeHtml(
          name
        )}</div>
                    <div class="breakdown-time">${hours}h</div>
                    <div class="breakdown-percentage">${percentage}%</div>
                </div>
            `;
      })
      .join('');
  }

  // Update activity list
  function updateActivityList() {
    if (!elements.activityList) return;

    syncActivitiesCache();
    const recentActivities = getFilteredActivities().slice(-10).reverse();
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

    elements.activityList.innerHTML = recentActivities
      .map(activity => {
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
                        <div class="activity-meta">${escapeHtml(activity.type)} • ${escapeHtml(
          file
        )}</div>
                    </div>
                </div>
            `;
      })
      .join('');
  }

  // Render the AI Tools card: per-tool status + today's active/run time + tokens,
  // plus the AI extensions inventory. All user-derived strings pass escapeHtml().
  function updateAiTools(data) {
    const list = elements.aiToolsList;
    const extensionsList = elements.aiExtensionsList;
    if (!list || !extensionsList) return;

    const payload = data || {};

    if (elements.aiOfflineHint) {
      elements.aiOfflineHint.hidden = !!payload.daemonAvailable;
    }

    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    if (tools.length === 0) {
      list.innerHTML = '<div class="ai-empty">No AI tool activity today</div>';
    } else {
      list.innerHTML = tools
        .map(tool => {
          const statusClass =
            tool.status === 'terminal' || tool.status === 'running' ? tool.status : 'idle';
          const statusLabel =
            statusClass === 'terminal' ? 'in terminal' : statusClass === 'running' ? 'running' : 'idle';
          const tokens = `${formatTokens(tool.inputTokens)} in / ${formatTokens(tool.outputTokens)} out`;

          return `
            <div class="ai-tool-item">
              <div class="ai-tool-head">
                <span class="ai-tool-name" title="${escapeHtml(tool.tool || '')}">${escapeHtml(
            tool.tool || 'unknown'
          )}</span>
                <span class="ai-status-pill ${statusClass}">${escapeHtml(statusLabel)}</span>
              </div>
              <div class="ai-tool-metrics">
                <span title="Gap-windowed active work time today">Active ${escapeHtml(
                  formatTime(tool.activeMsToday || 0)
                )}</span>
                <span title="Wall-clock run time today">Run ${escapeHtml(
                  formatTime(tool.runMsToday || 0)
                )}</span>
                <span title="Tokens today (input / output)">${escapeHtml(tokens)}</span>
              </div>
            </div>`;
        })
        .join('');
    }

    const extensions = Array.isArray(payload.extensions) ? payload.extensions : [];
    if (extensions.length === 0) {
      extensionsList.innerHTML = '<div class="ai-empty">No AI extensions detected</div>';
    } else {
      extensionsList.innerHTML = extensions
        .map(
          ext => `
            <div class="ai-extension-item">
              <span class="ai-extension-name" title="${escapeHtml(ext.id || '')}">${escapeHtml(
            ext.displayName || ext.id || 'unknown'
          )}</span>
              <span class="ai-extension-version">${escapeHtml(ext.version || '')}</span>
              <span class="ai-status-pill ${ext.isActive ? 'running' : 'idle'}">${
            ext.isActive ? 'active' : 'inactive'
          }</span>
            </div>`
        )
        .join('');
    }
  }

  function formatTokens(value) {
    const count = Number(value) || 0;
    if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
    if (count >= 1e3) return `${(count / 1e3).toFixed(1)}k`;
    return String(count);
  }

  function runQuickCommand(rawValue) {
    const commandText = String(rawValue || '').trim();
    if (!commandText) {
      return;
    }

    const quickInput = document.getElementById('quickCommandInput');
    if (quickInput) {
      quickInput.value = '';
    }

    if (commandText[0] !== '/') {
      sessionsState.filters.search = commandText;
      applySessionsFilters();
      return;
    }

    const spaceIndex = commandText.indexOf(' ');
    const command = (spaceIndex === -1 ? commandText : commandText.slice(0, spaceIndex)).toLowerCase();
    const payload = (spaceIndex === -1 ? '' : commandText.slice(spaceIndex + 1)).trim();

    if (command === '/tag') {
      const tags = parseTagInput(payload);
      if (tags.length === 0) {
        showError('Tag command requires at least one tag.');
        return;
      }
      vscode.postMessage({ command: 'addSessionTag', tags });
      return;
    }

    if (command === '/clear-tags') {
      vscode.postMessage({ command: 'clearSessionTags' });
      return;
    }

    if (command === '/filter') {
      vscode.postMessage({ command: 'filterByTag', tag: parseQuickFilter(payload) });
      return;
    }

    showError('Unknown quick command. Use /tag, /filter, or /clear-tags.');
  }

  function parseQuickFilter(payload) {
    const value = parseTagInput(payload)[0] || '';
    return value || null;
  }

  function applyLocalTagFilter(rawTag) {
    setTagFilterLocally(rawTag, false);
    dashboardData.activeTagFilter = sessionsState.filters.tag || null;

    applySessionsFilters();
    syncActivitiesCache();
  }

  function syncTagFilterFromDashboard(rawTag) {
    setTagFilterLocally(rawTag, true);
  }

  function setTagFilterLocally(rawTag, syncToHost) {
    const normalized = normalizeTag(rawTag);
    sessionsState.filters.tag = normalized;

    const tagFilterEl = document.getElementById('sessionTagFilter');
    if (tagFilterEl) {
      if (normalized && !Array.from(tagFilterEl.options).some(option => option.value === normalized)) {
        const fallbackOption = document.createElement('option');
        fallbackOption.value = normalized;
        fallbackOption.textContent = normalized;
        tagFilterEl.appendChild(fallbackOption);
      }

      if (tagFilterEl.value !== normalized) {
        tagFilterEl.value = normalized;
      }
    }

    if (syncToHost) {
      vscode.postMessage({ command: 'filterByTag', tag: normalized || null });
    }
  }

  function syncActivitiesCache() {
    const sourceSessions = sessionsState.raw.length > 0 ? sessionsState.raw : dashboardData.sessions || [];
    dashboardData.sessionsLookup = sourceSessions.reduce((map, session) => {
      if (session && session.id) {
        map[session.id] = session;
      }
      return map;
    }, {});
  }

  function getSessionFromCache(sessionId) {
    return (sessionId && dashboardData.sessionsLookup && dashboardData.sessionsLookup[sessionId]) || null;
  }

  function getFilteredActivities() {
    const activeTag = normalizeTag(sessionsState.filters.tag);
    const activeProject = sessionsState.filters.project;
    const activeLanguage = sessionsState.filters.language;

    return (dashboardData.activities || []).filter(activity => {
      if (activeProject && (activity.project || '') !== activeProject) return false;
      if (activeLanguage && (activity.language || '') !== activeLanguage) return false;

      if (!activeTag) return true;
      const session = getSessionFromCache(activity.sessionId);
      if (!session) return false;

      const sessionTags = new Set(getSessionTags(session));
      return sessionTags.has(activeTag);
    });
  }

  function parseTagInput(rawTags) {
    return String(rawTags || '')
      .split(',')
      .map(tag => tag.trim().toLowerCase())
      .filter(tag => tag.length > 0)
      .filter((tag, index, tags) => tags.indexOf(tag) === index);
  }

  function normalizeTag(value) {
    if (!value) {
      return '';
    }
    return String(value).trim().toLowerCase();
  }

  function getSessionTags(session) {
    if (!session || !session.tags) {
      return [];
    }

    if (Array.isArray(session.tags)) {
      return parseTagInput(session.tags.join(','));
    }

    if (typeof session.tags === 'string') {
      try {
        const parsed = JSON.parse(session.tags);
        if (Array.isArray(parsed)) {
          return parseTagInput(parsed.join(','));
        }
      } catch {
        return parseTagInput(session.tags);
      }
    }

    return [];
  }

  function getSessionTagSummary(session) {
    return getSessionTags(session).join(',');
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

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}`;
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
      const hue = ((i * 360) / count + hueOffset) % 360;
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
    const goalCardMetricNodes = [];

    [elements.globalDailyGoal, elements.globalWeeklyGoal, elements.projectDailyGoal, elements.projectWeeklyGoal].forEach(card => {
      if (!card) {
        return;
      }

      const valueEl = card.querySelector('.goal-metric-value');
      const detailEl = card.querySelector('.goal-metric-detail');
      if (valueEl) {
        goalCardMetricNodes.push(valueEl);
      }
      if (detailEl) {
        goalCardMetricNodes.push(detailEl);
      }
    });

    const loadingElements = [
      elements.sessionTimer,
      elements.todayTotalTime,
      elements.todayActiveTime,
      elements.todayProductivity,
      elements.goalProjectName,
      ...goalCardMetricNodes
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
    setInterval(() => {
      requestFullData();
      requestWindowSessions(sessionsState.filters.days || 30);
    }, 60000);
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Cleanup on page unload
  window.addEventListener('beforeunload', function () {
    Object.values(charts).forEach(chart => {
      if (chart) {
        chart.destroy();
      }
    });
  });
})();
