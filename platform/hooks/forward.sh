#!/usr/bin/env bash
# Universal Code Pulse hook forwarder — appends a protocol envelope to the spool.
# Tool-specific wrappers set CODEPULSE_SCANNER_ID and CODEPULSE_TOOL before exec'ing this script.
set -euo pipefail

INPUT=$(cat)
CODEPULSE_HOME="${CODEPULSE_HOME:-${HOME}/.codepulse}"
SPOOL="${CODEPULSE_SPOOL:-${CODEPULSE_HOME}/spool/events.ndjson}"
SCANNER_ID="${CODEPULSE_SCANNER_ID:-unknown}"
TOOL="${CODEPULSE_TOOL:-unknown}"
TOOL_DISPLAY="${CODEPULSE_TOOL_DISPLAY:-$TOOL}"

mkdir -p "$(dirname "$SPOOL")"

export INPUT
python3 - "$SPOOL" "$SCANNER_ID" "$TOOL" "$TOOL_DISPLAY" <<'PY'
import hashlib
import json
import os
import sys
import time
import uuid

spool_path, scanner_id, tool, tool_display = sys.argv[1:5]
raw_input = os.environ.get("INPUT", "")

try:
    hook_payload = json.loads(raw_input) if raw_input.strip() else {}
except json.JSONDecodeError:
    hook_payload = {"raw": raw_input[:4096]}

ts_ms = int(time.time() * 1000)
timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
content_hash = hashlib.sha256(raw_input.encode("utf-8")).hexdigest()

hook_event = hook_payload.get("hook_event_name") or hook_payload.get("hookEventName") or "hook"
tool_name = hook_payload.get("tool_name") or hook_payload.get("toolName") or tool

envelope = {
    "v": 1,
    "id": str(uuid.uuid4()),
    "ts": ts_ms,
    "src": "scanner",
    "type": "ai.tool.detected",
    "payload": {
        "type": "ai.tool.detected",
        "tool": tool_display,
        "confidence": 1.0,
        "evidence": [
            {
                "type": "hook_event",
                "timestamp": timestamp,
                "hash": content_hash,
            },
            {
                "type": "hook_event",
                "timestamp": timestamp,
                "hash": hashlib.sha256(f"{hook_event}:{tool_name}".encode("utf-8")).hexdigest(),
            }
        ],
        "scannerId": scanner_id,
    },
}

with open(spool_path, "a", encoding="utf-8") as spool:
    spool.write(json.dumps(envelope, separators=(",", ":")) + "\n")
PY

exit 0