#!/bin/sh
set -eu

# Explicit opt-in, observation only. No Git mutation or ChatGPT UI control.
ROOT="${FLYTO2_ROOT:-$HOME/flytohub}"
SCRIPT="$ROOT/flyto-runtime/scripts/worktree-control.py"
LABEL="com.flyto2.worktree-watch"
AGENTS="$HOME/Library/LaunchAgents"
STATE="$HOME/Library/Application Support/Flyto2 Runtime/worktree-watch"
PLIST="$AGENTS/$LABEL.plist"
test -f "$SCRIPT" || { echo "Missing $SCRIPT" >&2; exit 1; }
mkdir -p "$AGENTS" "$STATE"
python3 - "$PLIST" "$SCRIPT" "$ROOT" "$STATE" "$LABEL" <<'PY'
import pathlib, plistlib, sys
plist, script, root, state, label = sys.argv[1:]
payload = {
    'Label': label,
    'ProgramArguments': ['/usr/bin/python3', script, '--root', root,
                         '--output', str(pathlib.Path(state) / 'inventory.json'),
                         '--watch', '300'],
    'RunAtLoad': True,
    'KeepAlive': {'SuccessfulExit': False},
    'StandardOutPath': str(pathlib.Path(state) / 'stdout.log'),
    'StandardErrorPath': str(pathlib.Path(state) / 'stderr.log'),
    'ProcessType': 'Background',
}
with open(plist, 'wb') as stream:
    plistlib.dump(payload, stream)
PY
chmod 600 "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart "gui/$(id -u)/$LABEL"
echo "Installed read-only inventory watcher: $PLIST"
