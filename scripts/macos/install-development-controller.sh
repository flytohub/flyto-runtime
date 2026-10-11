#!/bin/sh
set -eu
# Explicit installation only; queued tasks are user-authored in tasks.json.
ROOT="${FLYTO2_ROOT:-$HOME/flytohub}"
SCRIPT="$ROOT/flyto-runtime/scripts/host-development-controller.py"
LABEL=com.flyto2.development-controller
STATE="$HOME/Library/Application Support/Flyto2 Runtime/development-controller"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
test -f "$SCRIPT" || { echo "Missing $SCRIPT; merge and deploy the controller first" >&2; exit 1; }
mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
python3 - "$PLIST" "$SCRIPT" "$ROOT" "$STATE" "$LABEL" <<'PY'
import plistlib, sys
plist, script, root, state, label = sys.argv[1:]
with open(plist, 'wb') as f:
    plistlib.dump({'Label': label, 'ProgramArguments': ['/usr/bin/python3', script, '--root', root, '--state', state],
                   'RunAtLoad': True, 'KeepAlive': {'SuccessfulExit': False}, 'ProcessType': 'Background',
                   'StandardOutPath': state + '/stdout.log', 'StandardErrorPath': state + '/stderr.log'}, f)
PY
chmod 600 "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart "gui/$(id -u)/$LABEL"
echo "Controller installed; add explicitly approved tasks to $STATE/tasks.json"
