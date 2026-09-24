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
LOGIN_PATH="$(login_shell_path)"
export PATH="${LOGIN_PATH:+$LOGIN_PATH:}$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
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
