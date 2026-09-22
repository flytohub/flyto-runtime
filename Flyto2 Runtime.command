#!/bin/bash
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
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

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm was not found. Run: corepack enable"
fi

if [[ ! -d node_modules ]]; then
  echo "First launch: installing Flyto2 Runtime dependencies..."
  pnpm install --frozen-lockfile || fail "Dependency installation failed."
fi

needs_build=0
if [[ ! -f dist/cli.js ]]; then
  needs_build=1
elif find src package.json tsconfig.build.json vite.config.ts -type f -newer dist/cli.js -print -quit 2>/dev/null | grep -q .; then
  needs_build=1
fi
if [[ "$needs_build" == 1 ]]; then
  echo "Updating Flyto2 Runtime build..."
  pnpm build || fail "Build failed."
fi

case "$MODE" in
  menu)
    node dist/cli.js menu
    ;;
  start)
    node dist/cli.js serve
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
  *)
    node dist/cli.js "$MODE"
    ;;
esac
result=$?

printf '\nPress Enter to close this window.'
read -r _
exit "$result"
