# Changelog

All notable changes to the CodePulse extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Git branch detection for coding sessions
- Data retention policy with configurable `dataRetentionDays` setting (default: 90 days)
- Keyboard shortcuts: toggle tracking (Ctrl+Shift+Alt+T), dashboard (Ctrl+Shift+Alt+D), stats (Ctrl+Shift+Alt+S)
- Docker-based local CI pipeline (`docker compose build ci`)
- `npm run ci` script for quick local lint + typecheck + build
- CONTRIBUTING.md guide
- This CHANGELOG

### Fixed
- Timezone bug in `ProductivityScorer.calculateWeeklyProductivityTrend` using `toISOString()` instead of local dates
- Deprecated `url.parse` replaced with `new URL()` in API server
- Export version mismatch (was `1.1.0`, corrected to `1.0.0`)
- Removed dead `parseRequestBody` method from API server
- Fixed all ESLint errors (empty constructors, inferrable types, constant conditions)

## [1.0.0] - 2026-04-11

### Added
- Automatic time tracking with heartbeat monitoring
- Intelligent idle detection and activity tracking
- SQLite local storage with schema migrations (v1-v3)
- Session segments for granular active/idle tracking
- Productivity scoring with multi-factor analysis
- Interactive dashboard with Chart.js visualizations
- Project and language detection (20+ languages)
- Local REST API server for external integrations
- Cloud sync with retry queue
- Privacy controls: filename hiding, data anonymization (SHA-256)
- Daily rollup aggregation for fast stats queries
- Data export to JSON
- Status bar with live session timer
- Configurable heartbeat intervals and idle thresholds
