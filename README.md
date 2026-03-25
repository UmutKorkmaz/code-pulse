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

1. **From VS Code Marketplace** (Coming Soon)
   - Open VS Code
   - Go to Extensions (Ctrl+Shift+X)
   - Search for "CodePulse"
   - Click Install

2. **From Source**
   ```bash
   git clone <repository-url>
   cd codepulse
   npm install
   npm run compile
   # Install the .vsix file in VS Code
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

### Cloud Sync (Optional)

```json
{
    "codepulse.cloudSync.enabled": false,
    "codepulse.cloudSync.apiUrl": "https://your-api.com",
    "codepulse.cloudSync.apiKey": "your-api-key"
}
```

### Local API Server

```json
{
    "codepulse.localServer.enabled": false,
    "codepulse.localServer.port": 8080,
    "codepulse.localServer.allowExternalConnections": false
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

### Example Usage

```bash
# Get current session
curl http://localhost:8080/current

# Get today's stats
curl http://localhost:8080/today

# Get last 30 days project stats
curl http://localhost:8080/projects?days=30
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
git clone <repository-url>
cd codepulse

# Install dependencies
npm install

# Start development
npm run watch

# Run tests
npm run test

# Package extension
npm run package
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

- [ ] VS Code Marketplace publication
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

- 🐛 **Bug Reports**: [GitHub Issues](<repository-url>/issues)
- 💡 **Feature Requests**: [GitHub Discussions](<repository-url>/discussions)
- 📧 **Email**: support@codepulse.dev
- 💬 **Discord**: [Join our community](<discord-invite>)

---

**Made with ❤️ for developers, by developers.**

*Start tracking your coding journey today and unlock insights into your development productivity!*