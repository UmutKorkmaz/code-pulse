# Contributing to CodePulse

Thank you for your interest in contributing to CodePulse! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 18+
- npm 9+
- VS Code 1.74+
- Docker (optional, for local CI)

### Getting Started

```bash
git clone https://github.com/UmutKorkmaz/code-pulse.git
cd code-pulse
npm install
npm run compile
```

### Development Workflow

1. **Start watch mode** for live compilation:
   ```bash
   npm run watch
   ```

2. **Run the extension** in a development host:
   - Press `F5` in VS Code to launch the Extension Development Host

3. **Run linting**:
   ```bash
   npm run lint
   npm run lint:fix  # auto-fix where possible
   ```

4. **Run tests**:
   ```bash
   npm test
   ```

5. **Run the full local CI pipeline** (via Docker):
   ```bash
   ./scripts/ci-local.sh
   ```

## Project Structure

```
src/
  extension.ts          # Entry point
  tracker/              # Time tracking (sessions, heartbeats, activity)
  storage/              # SQLite database and cloud sync
  analytics/            # Productivity scoring and statistics
  detectors/            # Language and project detection
  ui/                   # Status bar and webview dashboard
  api/                  # Local REST API server
  utils/                # Config, dates, privacy, logging
webview/                # Dashboard HTML/CSS/JS
test/                   # Test suite
```

## Coding Standards

- TypeScript strict mode is enabled
- Run `npm run lint` before committing
- Follow existing patterns in the codebase
- Keep functions under 50 lines where practical
- Add tests for new functionality

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes with clear, focused commits
4. Ensure `npm run ci` passes (lint + typecheck + build)
5. Open a pull request against `main`

## Commit Message Format

```
<type>: <description>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`

## Reporting Issues

- Use [GitHub Issues](https://github.com/UmutKorkmaz/code-pulse/issues)
- Include VS Code version, OS, and steps to reproduce
- Attach relevant log output if applicable

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
