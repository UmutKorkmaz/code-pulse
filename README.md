# CodePulse - Advanced Time Tracking for Developers

CodePulse is a comprehensive VS Code extension that automatically tracks your coding time, analyzes productivity patterns, and provides detailed insights into your development workflow. Think of it as your personal coding analytics dashboard, similar to WakaTime but with enhanced features and complete privacy control.

## ✨ Features

### 🕒 **Automatic Time Tracking**
- Real-time session tracking with heartbeat monitoring
- Intelligent idle detection and activity monitoring  
- File, project, and language-specific time tracking
- Seamless background operation without interrupting your flow

### 📊 **Beautiful Analytics Dashboard**
- Interactive charts and visualizations
- Daily, weekly, and monthly productivity trends
- Project and language breakdowns with detailed statistics
- Productivity scoring with actionable insights

### 🎯 **Smart Productivity Insights**
- AI-powered productivity scoring based on coding patterns
- Keystroke velocity and focus time analysis
- Code churn analysis (additions vs. deletions)
- Peak productivity hours identification
- Personalized recommendations for improvement

### 🔒 **Privacy First**
- Complete local data storage with SQLite
- Optional cloud synchronization with your own API
- Configurable privacy settings for filename and content tracking
- Data anonymization options available

### 🚀 **Advanced Features**
- Local REST API server for external integrations
- Export capabilities for all your data
- Customizable tracking intervals and idle thresholds
- Multiple project workspace support
- Real-time status bar integration

### 🌐 **Developer Friendly**
- Local API server for building custom integrations
- JSON data export for analysis in external tools
- Comprehensive configuration options
- TypeScript codebase with full type safety

## 📸 Screenshots

> Dashboard screenshots will be added here once the extension is running

## 🚀 Getting Started

### Installation

1. **From VS Code Marketplace**
   - Open VS Code
   - Go to Extensions (Ctrl+Shift+X)
   - Search for `Code Pulse Tracker`
   - Install `umutkorkmaz.code-pulse-tracker`
   - Click Install

2. **From a local VSIX**
   ```bash
   code --install-extension code-pulse-tracker-1.2.2.vsix
   ```

3. **From Source**
   ```bash
   git clone https://github.com/UmutKorkmaz/code-pulse.git
   cd code-pulse
   npm install
   npm run package
   code --install-extension code-pulse-tracker-1.2.2.vsix
   ```

4. **Desktop app, CLI, daemon, and MCP**
   ```bash
   cd platform
   npm install
   npm run build
   node apps/daemon/dist/main.js
   ```

   In another terminal:
   ```bash
   node apps/cli/dist/index.js doctor
   node apps/cli/dist/index.js status
   ```

### Quick Setup

1. **Activate the Extension**
   - CodePulse starts automatically when VS Code launches
   - Look for the pulse icon in your status bar

2. **View Your Dashboard**
   - Click the CodePulse status bar item, or
   - Open Command Palette (Ctrl+Shift+P) and run "CodePulse: Show Dashboard"

3. **Configure Settings** (Optional)
   - Open VS Code Settings
   - Search for "CodePulse"
   - Customize tracking intervals, privacy settings, and more

## ⚙️ Configuration

### Basic Settings

```json
{
    "codepulse.enabled": true,
    "codepulse.heartbeatInterval": 120,
    "codepulse.idleThreshold": 300,
    "codepulse.showStatusBar": true
}
```

### Privacy Settings

```json
{
    "codepulse.privacy.trackFilenames": true,
    "codepulse.privacy.trackFileContent": false,
    "codepulse.privacy.anonymizeData": false
}
```

### Goal Tracking Settings

Code Pulse supports global and per-project goals for both daily and weekly windows.

```json
{
    "codepulse.goals.enabled": true,
    "codepulse.goals.dailyMinutes": 240,
    "codepulse.goals.weeklyMinutes": 1200,
    "codepulse.goals.milestoneNotifications": true,
    "codepulse.goals.projectGoals": {
      "my-workspace": {
        "dailyMinutes": 180,
        "weeklyMinutes": 900
      },
      "my-open-source-project": {
        "dailyMinutes": 120
      }
    }
}
```

Open the dashboard via `Code Pulse: Show Dashboard` or `Code Pulse: Show Goals` to view:
- Global daily/weekly percentage
- Remaining time
- ETA when pacing is sufficient

Per-project goals apply when the tracker is currently on that project and can be set independently of global goals.

### Cloud Sync (Optional)

```json
{
    "codepulse.cloudSync.enabled": false,
    "codepulse.cloudSync.apiUrl": "https://your-api.com",
    "codepulse.cloudSync.apiKey": "..."
}
```
Use VS Code's secure secret settings UI for API keys and access tokens rather than committing values in plain text.

### Local API Server

```json
{
    "codepulse.localServer.enabled": false,
    "codepulse.localServer.port": 8080,
    "codepulse.localServer.allowExternalConnections": false,
    "codepulse.localServer.apiToken": "set via secret setting"
}
```

## 🔧 API Documentation

CodePulse includes a local REST API server for building custom integrations.

### Available Endpoints

- `GET /status` - Extension status and health check
- `GET /current` - Current active session
- `GET /today` - Today's statistics  
- `GET /week` - This week's statistics
- `GET /stats?days=30` - Statistics for specified period
- `GET /projects?days=30` - Project breakdown
- `GET /languages?days=30` - Language breakdown
- `GET /sessions?start=DATE&end=DATE` - Session data
- `GET /export` - Export all data

### Authentication

Every request — including on localhost — requires a bearer token; the API never
serves your coding-activity data unauthenticated. The token is the
`codepulse.localServer.apiToken` setting if set, otherwise a random token is
generated once and persisted (mode `0600`) under the extension's global storage.
Run the **Code Pulse: Copy Local API Token** command to copy the active token to
your clipboard. Requests with a non-loopback `Host` header are rejected (`403`)
as a DNS-rebinding defense.

### Example Usage

```bash
# Get current session (token via Authorization header)
curl -H "Authorization: Bearer <your local API token>" http://localhost:8080/current

# Get today's stats
curl -H "Authorization: Bearer <your local API token>" http://localhost:8080/today

# Token may also be passed as a query parameter
curl "http://localhost:8080/projects?days=30&token=<your local API token>"
```

## 🎨 Customization

### Themes

CodePulse automatically adapts to your VS Code theme:
- Dark themes: Optimized for dark backgrounds
- Light themes: Adapted for light backgrounds  
- High contrast: Full accessibility support

### Status Bar

Customize your status bar display:
- Toggle visibility
- Choose compact or detailed mode
- Configure update intervals

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup

```bash
# Clone the repository
git clone https://github.com/UmutKorkmaz/code-pulse.git
cd code-pulse

# Install dependencies
npm install

# Start development
npm run watch

# Run tests
npm run test

# Package extension
npm run package
```

### Desktop Release Build

```bash
cd platform
npm install
npm run build
cd apps/desktop
npm run tauri:build
```

Native installers are emitted under `platform/apps/desktop/src-tauri/target/release/bundle/`.

### Publish Site and Desktop Artifacts

The GitHub Pages workflow publishes the `site/` directory:

```bash
gh workflow run pages.yml --repo UmutKorkmaz/code-pulse --ref main
RUN_ID=$(gh run list --repo UmutKorkmaz/code-pulse --workflow pages.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch --repo UmutKorkmaz/code-pulse "$RUN_ID"
gh api repos/UmutKorkmaz/code-pulse/pages --jq '.html_url'
```

Download a desktop release artifact:

```bash
gh release download v1.2.2 --repo UmutKorkmaz/code-pulse --pattern "*.dmg" --dir dist/releases
open dist/releases/*.dmg
```

### Project Structure

```
codepulse/
├── src/                    # TypeScript source code
│   ├── extension.ts        # Main extension entry point
│   ├── tracker/           # Time tracking components
│   ├── storage/           # Database and cloud sync
│   ├── analytics/         # Analytics and scoring
│   ├── detectors/         # Language and project detection
│   ├── ui/                # UI components and webviews
│   ├── api/               # Local API server
│   └── utils/             # Utilities and configuration
├── webview/               # Dashboard HTML/CSS/JS
├── test/                  # Test files
├── .vscode/               # VS Code configuration
└── package.json           # Extension manifest
```

## 📋 Roadmap

- [x] VS Code Marketplace-ready extension identity (`umutkorkmaz.code-pulse-tracker`)
- [ ] Signed desktop installers on GitHub Releases
- [ ] Advanced code complexity analysis
- [ ] Team collaboration features
- [ ] Integration with popular project management tools
- [ ] Mobile companion app
- [ ] Machine learning-powered productivity predictions
- [ ] Custom dashboard themes
- [ ] Plugin system for extensibility

## ❓ FAQ

**Q: Is my data private?**
A: Yes! All data is stored locally on your machine by default. Cloud sync is optional and you control your own API endpoint.

**Q: Does this slow down VS Code?**
A: No. CodePulse is designed to be lightweight and runs asynchronously without affecting editor performance.

**Q: Can I use this with multiple workspaces?**
A: Yes! CodePulse automatically detects workspace changes and tracks time per project.

**Q: How accurate is the productivity scoring?**
A: The productivity score uses multiple factors including keystroke velocity, focus time, and code churn. It learns from your patterns and provides relative scoring.

**Q: Can I export my data?**
A: Absolutely! You can export all your data as JSON for analysis in external tools.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Inspired by WakaTime's time tracking concept
- Built with love for the developer community
- Thanks to all contributors and beta testers

## 📞 Support

- 🐛 **Bug Reports**: [GitHub Issues](https://github.com/UmutKorkmaz/code-pulse/issues)
- 💡 **Feature Requests**: [GitHub Discussions](https://github.com/UmutKorkmaz/code-pulse/discussions)
- 📧 **Email**: support@codepulse.dev

---

**Made with ❤️ for developers, by developers.**

*Start tracking your coding journey today and unlock insights into your development productivity!*
