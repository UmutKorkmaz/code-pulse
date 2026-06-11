#!/usr/bin/env bash
# Install Code Pulse hook forwarder into Claude Code (~/.claude/settings.json).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEPULSE_HOME="${CODEPULSE_HOME:-$HOME/.codepulse}"
HOOKS_DIR="$CODEPULSE_HOME/hooks"
FORWARDER="$HOOKS_DIR/claude-forward.sh"
CLAUDE_SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

mkdir -p "$HOOKS_DIR" "$CODEPULSE_HOME/spool" "$(dirname "$CLAUDE_SETTINGS")"

cp "$SCRIPT_DIR/forward.sh" "$HOOKS_DIR/forward.sh"
chmod +x "$HOOKS_DIR/forward.sh"

cat >"$FORWARDER" <<'WRAPPER'
#!/usr/bin/env bash
export CODEPULSE_SCANNER_ID="scn.claude-code"
export CODEPULSE_TOOL="claude-code"
export CODEPULSE_TOOL_DISPLAY="Claude Code"
exec "${CODEPULSE_HOME:-$HOME/.codepulse}/hooks/forward.sh"
WRAPPER
chmod +x "$FORWARDER"

python3 - "$CLAUDE_SETTINGS" "$FORWARDER" <<'PY'
import json
import pathlib
import sys

settings_path = pathlib.Path(sys.argv[1]).expanduser()
forwarder = sys.argv[2]
events = ["PreToolUse", "PostToolUse", "SessionStart", "Stop"]

config: dict = {}
if settings_path.exists():
    try:
        config = json.loads(settings_path.read_text(encoding="utf-8") or "{}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in {settings_path}: {exc}") from exc

if not isinstance(config, dict):
    raise SystemExit(f"Expected object at root of {settings_path}")

hooks = config.setdefault("hooks", {})
if not isinstance(hooks, dict):
    raise SystemExit(f"Expected hooks object in {settings_path}")

for event in events:
    groups = hooks.setdefault(event, [])
    if not isinstance(groups, list):
        raise SystemExit(f"Expected hooks.{event} to be an array in {settings_path}")

    group = None
    for candidate in groups:
        if not isinstance(candidate, dict):
            continue
        matcher = candidate.get("matcher")
        if matcher in (None, "", "*"):
            group = candidate
            break

    if group is None:
        group = {}
        groups.append(group)

    handlers = group.setdefault("hooks", [])
    if not isinstance(handlers, list):
        raise SystemExit(f"Expected hooks.{event} handler list in {settings_path}")

    already_installed = any(
        isinstance(handler, dict)
        and handler.get("type") == "command"
        and handler.get("command") == forwarder
        for handler in handlers
    )

    if not already_installed:
        handlers.append({"type": "command", "command": forwarder})

settings_path.parent.mkdir(parents=True, exist_ok=True)
settings_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
print(f"Installed Claude Code hooks -> {forwarder}")
PY