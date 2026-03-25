# CodePulse Project Structure

## Overview

CodePulse is a VS Code extension for advanced time tracking and productivity
analytics for developers. The project follows a modular architecture with clear
separation of concerns.

## Directory Structure

```
codepulse/
├── src/                    # TypeScript source code
│   ├── extension.ts        # Main extension entry point
│   ├── tracker/           # Time tracking components
│   │   ├── TimeTracker.ts      # Core time tracking logic
│   │   ├── HeartbeatManager.ts # Heartbeat monitoring
│   │   └── ActivityDetector.ts # Activity detection
│   ├── storage/           # Database and cloud sync
│   │   ├── DatabaseManager.ts  # SQLite database operations
│   │   └── CloudSync.ts        # Cloud synchronization
│   ├── analytics/         # Analytics and scoring
│   │   ├── AnalyticsEngine.ts  # Data analysis and insights
│   │   └── ProductivityScorer.ts # Productivity scoring
│   ├── detectors/         # Language and project detection
│   │   ├── LanguageDetector.ts # Programming language detection
│   │   └── ProjectDetector.ts  # Project/workspace detection
│   ├── ui/                # UI components and webviews
│   │   ├── StatusBarManager.ts # Status bar management
│   │   └── WebviewProvider.ts  # Dashboard webview
│   ├── api/               # Local API server
│   │   └── ApiServer.ts        # REST API for integrations
│   └── utils/             # Utilities and configuration
│       ├── ConfigManager.ts     # Configuration management
│       └── Logger.ts           # Logging system
├── webview/               # Dashboard HTML/CSS/JS
│   ├── dashboard.js       # Dashboard JavaScript logic
│   ├── dashboard.css      # Dashboard styling
│   ├── main.js            # Main webview script
│   ├── main.css           # Main webview styling
│   ├── vscode.css         # VS Code theme integration
│   └── chart.min.js       # Chart.js library
├── test/                  # Test files
│   ├── fixtures/          # Test data fixtures
│   │   └── sample-session.json
│   └── suite/             # Test suites
│       ├── extension.test.ts
│       ├── configManager.test.ts
│       ├── timeTracker.test.ts
│       └── index.ts
├── out/                   # Compiled JavaScript output
│   ├── analytics/         # Compiled analytics modules
│   ├── api/               # Compiled API modules
│   ├── detectors/         # Compiled detector modules
│   ├── storage/           # Compiled storage modules
│   ├── tracker/           # Compiled tracker modules
│   ├── ui/                # Compiled UI modules
│   ├── utils/             # Compiled utility modules
│   └── extension.js       # Main extension entry point
├── extension/             # Extension assets
│   ├── icon.png          # Extension icon
│   └── icon.svg          # Extension icon (SVG)
├── .eslintrc.json        # ESLint configuration
├── .prettierrc           # Prettier configuration
├── .vscodeignore         # VS Code ignore file
├── LICENSE               # MIT license
├── README.md             # Project documentation
├── package.json          # Extension manifest and dependencies
├── tsconfig.json         # TypeScript configuration
└── codepulse-1.0.0.vsix   # Packaged extension file
```

## Core Components

### 1. Extension Entry Point (`src/extension.ts`)

- Main extension lifecycle management
- Component initialization and dependency injection
- Command registration and event handling
- Extension activation/deactivation logic

### 2. Time Tracking Module (`src/tracker/`)

- **TimeTracker.ts**: Core time tracking logic, session management
- **HeartbeatManager.ts**: Periodic heartbeat monitoring for activity detection
- **ActivityDetector.ts**: User activity detection and idle time tracking

### 3. Storage Module (`src/storage/`)

- **DatabaseManager.ts**: SQLite database operations, data persistence
- **CloudSync.ts**: Optional cloud synchronization capabilities

### 4. Analytics Module (`src/analytics/`)

- **AnalyticsEngine.ts**: Data analysis, statistics generation, insights
- **ProductivityScorer.ts**: AI-powered productivity scoring algorithms

### 5. Detection Module (`src/detectors/`)

- **LanguageDetector.ts**: Programming language detection from file extensions
- **ProjectDetector.ts**: Project/workspace identification and tracking

### 6. UI Module (`src/ui/`)

- **StatusBarManager.ts**: VS Code status bar integration and updates
- **WebviewProvider.ts**: Dashboard webview management and communication

### 7. API Module (`src/api/`)

- **ApiServer.ts**: Local REST API server for external integrations

### 8. Utilities Module (`src/utils/`)

- **ConfigManager.ts**: Configuration management and settings
- **Logger.ts**: Logging system for debugging and monitoring

## Data Flow

1. **Extension Activation**: `extension.ts` initializes all components
2. **Time Tracking**: `TimeTracker` monitors user activity via
   `HeartbeatManager` and `ActivityDetector`
3. **Data Storage**: `DatabaseManager` persists sessions and activities to
   SQLite
4. **Analytics**: `AnalyticsEngine` processes stored data to generate insights
5. **UI Updates**: `StatusBarManager` and `WebviewProvider` update the interface
6. **API Access**: `ApiServer` provides REST endpoints for external access

## Key Features Architecture

### Time Tracking

- Real-time session tracking with heartbeat monitoring
- Intelligent idle detection and activity monitoring
- File, project, and language-specific time tracking
- Automatic session creation and management

### Analytics Engine

- Daily, weekly, and monthly productivity trends
- Project and language breakdowns with detailed statistics
- Time distribution analysis by hour and day of week
- Coding streak tracking and productivity scoring

### Privacy & Security

- Complete local data storage with SQLite
- Optional cloud synchronization with user-controlled API
- Configurable privacy settings for filename and content tracking
- Data anonymization options

### Integration Capabilities

- Local REST API server for external integrations
- JSON data export for analysis in external tools
- VS Code status bar integration
- Command palette commands for quick access

## Configuration

The extension supports extensive configuration through VS Code settings:

- Basic tracking settings (intervals, thresholds)
- Privacy controls (data tracking, anonymization)
- Cloud sync configuration (API endpoints, authentication)
- Local API server settings (port, access control)
- Analytics preferences (scoring, statistics)

## Development Workflow

1. **Development**: `npm run watch` - Compile TypeScript in watch mode
2. **Testing**: `npm test` - Run test suites
3. **Linting**: `npm run lint` - Code quality checks
4. **Formatting**: `npm run format` - Code formatting
5. **Packaging**: `npm run package` - Create .vsix extension file
6. **Deployment**: `npm run deploy` - Publish to VS Code Marketplace

## Technology Stack

- **Language**: TypeScript
- **Database**: SQLite3
- **Framework**: VS Code Extension API
- **UI**: HTML/CSS/JavaScript with Chart.js
- **Testing**: Mocha
- **Linting**: ESLint
- **Formatting**: Prettier
- **Build**: TypeScript Compiler

## Extension Points

The extension integrates with VS Code through:

- **Commands**: Custom commands in the command palette
- **Status Bar**: Real-time tracking information display
- **Webviews**: Interactive dashboard interface
- **Configuration**: Settings integration
- **Event Listeners**: File change, workspace change, configuration change
  events
- **Views**: Custom tree view in the explorer
- **Activity Bar**: Custom activity bar icon and menu
