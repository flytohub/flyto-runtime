#!/bin/bash
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
# Double-clicking a .command does not read the user's shell startup files, so
# Node from nvm/fnm/Volta and pnpm from its own installer are not on PATH yet.
# Ask the login shell for its PATH, giving up after 5 seconds.
login_shell_path() {
  local out pid _
  out="$(mktemp)" || return 0
  "${SHELL:-/bin/zsh}" -ilc 'printf "\n__FLYTO2_PATH__%s\n" "$PATH"' </dev/null >"$out" 2>/dev/null &
  pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill "$pid" 2>/dev/null
  sed -n 's/^__FLYTO2_PATH__//p' "$out" | tail -n 1
  rm -f "$out"
}
# The packaged app carries its own Node and is already built.
PACKAGED=0
if [[ -f "$ROOT/distribution.json" && -x "$ROOT/node/bin/node" ]]; then
  PACKAGED=1
  export PATH="$ROOT/node/bin:$PATH"
else
  # The caller's PATH wins: a Desktop launcher puts the Node the background
  # service runs on first, and the native modules must stay built for it. The
  # login shell only fills in what a double-click leaves out.
  LOGIN_PATH="$(login_shell_path)"
  export PATH="$PATH${LOGIN_PATH:+:$LOGIN_PATH}:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
fi
cd "$ROOT" || exit 1

MODE="${1:-menu}"

fail() {
  printf '\nFlyto2 Runtime failed to start: %s\n' "$1" >&2
  printf '\nPress Enter to close this window.'
  read -r _
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js was not found. Install Node >=22.19 and <27 first."
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?(a<27?0:1):1)' >/dev/null 2>&1; then
  fail "Unsupported Node.js version. Required: >=22.19 <27. Current: $(node -v)."
fi

if [[ "$PACKAGED" == 0 ]]; then
  # pnpm is found, never installed: enabling corepack needs write access next to
  # node, which most installs lack, and Node 25+ has no corepack. Same order as
  # src/flyto2/pnpm-command.ts.
  PNPM_VERSION="$(node -p 'require("./package.json").packageManager.split("@")[1].split("+")[0]')" \
    || fail "package.json does not pin a pnpm version."
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  if command -v pnpm >/dev/null 2>&1; then
    PNPM=(pnpm)
  elif command -v corepack >/dev/null 2>&1; then
    PNPM=(corepack pnpm)
  elif command -v npm >/dev/null 2>&1; then
    PNPM=(npm exec --yes --package=pnpm@"$PNPM_VERSION" -- pnpm)
  else
    fail "pnpm was not found, and neither corepack nor npm is available to run it. Reinstall Node.js from https://nodejs.org."
  fi

  if [[ ! -d node_modules ]]; then
    echo "First launch: installing Flyto2 Runtime dependencies..."
    "${PNPM[@]}" install --frozen-lockfile || fail "Dependency installation failed."
  fi
  # Native modules are built for one Node ABI. After switching Node (nvm, an
  # upgrade) they fail to load with NODE_MODULE_VERSION, so rebuild them for
  # this Node here instead of failing once Runtime is running.
  # better-sqlite3 loads its binary only when a database opens, so open one.
  if ! node -e 'new (require("better-sqlite3"))(":memory:").close(); try { require.resolve("node-pty") } catch { process.exit(0) } require("node-pty")' >/dev/null 2>&1; then
    echo "Rebuilding native modules for Node $(node -v)..."
    "${PNPM[@]}" rebuild || fail "Rebuilding native modules for Node $(node -v) failed."
    REBUILT_NATIVE=1
  fi

  needs_build=0
  if [[ ! -f dist/cli.js ]]; then
    needs_build=1
  elif find src package.json tsconfig.build.json vite.config.ts -type f -newer dist/cli.js -print -quit 2>/dev/null | grep -q .; then
    needs_build=1
  fi
  if [[ "$needs_build" == 1 ]]; then
    echo "Updating Flyto2 Runtime build..."
    "${PNPM[@]}" build || fail "Build failed."
  fi
  # The modules now match this Node, so a background service still running this
  # checkout on another Node would fail on its next start. Move it to this one.
  SERVICE_PLIST="$HOME/Library/LaunchAgents/local.flyto2.runtime.plist"
  if [[ "${REBUILT_NATIVE:-0}" == 1 && -f "$SERVICE_PLIST" ]] && grep -qF "$ROOT/dist/cli.js" "$SERVICE_PLIST"; then
    echo "Moving the background service to Node $(node -v)..."
    node dist/cli.js service install >/dev/null || fail "Reinstalling the background service on Node $(node -v) failed."
  fi
fi

case "$MODE" in
  menu)
    node dist/cli.js menu
    ;;
  start)
    node dist/cli.js service start
    ;;
  doctor)
    node dist/cli.js doctor
    ;;
  setup)
    node dist/cli.js init --force
    ;;
  launcher-install)
    node dist/cli.js launcher install
    ;;
  app)
    node dist/cli.js app
    ;;
  install)
    # init is a no-op once configured, so a first run is walked through setup.
    node dist/cli.js init && node dist/cli.js service install && node dist/cli.js launcher install
    ;;
  *)
    node dist/cli.js "$MODE"
    ;;
esac
result=$?

printf '\nPress Enter to close this window.'
read -r _
exit "$result"
