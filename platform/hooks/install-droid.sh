#!/usr/bin/env bash
# Install Code Pulse hook forwarder into Factory Droid (~/.factory/hooks.json).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEPULSE_HOME="${CODEPULSE_HOME:-$HOME/.codepulse}"
HOOKS_DIR="$CODEPULSE_HOME/hooks"
FORWARDER="$HOOKS_DIR/droid-forward.sh"
DROID_HOOKS="${DROID_HOOKS:-$HOME/.factory/hooks.json}"

mkdir -p "$HOOKS_DIR" "$CODEPULSE_HOME/spool" "$(dirname "$DROID_HOOKS")"

cp "$SCRIPT_DIR/forward.sh" "$HOOKS_DIR/forward.sh"
chmod +x "$HOOKS_DIR/forward.sh"

cat >"$FORWARDER" <<'WRAPPER'
#!/usr/bin/env bash
export CODEPULSE_SCANNER_ID="scn.factory-droid"
export CODEPULSE_TOOL="droid"
export CODEPULSE_TOOL_DISPLAY="Factory Droid"
exec "${CODEPULSE_HOME:-$HOME/.codepulse}/hooks/forward.sh"
WRAPPER
chmod +x "$FORWARDER"

python3 - "$DROID_HOOKS" "$FORWARDER" <<'PY'
import json
import pathlib
import sys

hooks_path = pathlib.Path(sys.argv[1]).expanduser()
forwarder = sys.argv[2]
events = ["PreToolUse", "PostToolUse", "SessionEnd"]

config: dict = {}
if hooks_path.exists():
    try:
        config = json.loads(hooks_path.read_text(encoding="utf-8") or "{}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in {hooks_path}: {exc}") from exc

if not isinstance(config, dict):
    raise SystemExit(f"Expected object at root of {hooks_path}")

hooks = config.setdefault("hooks", {})
if not isinstance(hooks, dict):
    raise SystemExit(f"Expected hooks object in {hooks_path}")

for event in events:
    groups = hooks.setdefault(event, [])
    if not isinstance(groups, list):
        raise SystemExit(f"Expected hooks.{event} to be an array in {hooks_path}")

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
        raise SystemExit(f"Expected hooks.{event} handler list in {hooks_path}")

    already_installed = any(
        isinstance(handler, dict)
        and handler.get("type") == "command"
        and handler.get("command") == forwarder
        for handler in handlers
    )

    if not already_installed:
        handlers.append({"type": "command", "command": forwarder})

hooks_path.parent.mkdir(parents=True, exist_ok=True)
hooks_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
print(f"Installed Droid hooks -> {forwarder}")
PY