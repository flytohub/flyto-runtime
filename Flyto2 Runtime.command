#!/bin/bash
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$ROOT" || exit 1

MODE="${1:-menu}"

fail() {
  printf '\nFlyto2 Runtime 啟動失敗：%s\n' "$1" >&2
  printf '\n按 Enter 關閉視窗。'
  read -r _
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "找不到 Node.js。請先安裝 Node 22.19 以上（低於 27）。"
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?(a<27?0:1):1)' >/dev/null 2>&1; then
  fail "Node.js 版本不支援。需要 >=22.19 <27，目前是 $(node -v)。"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  fail "找不到 pnpm。請先執行 corepack enable。"
fi

if [[ ! -d node_modules ]]; then
  echo "第一次啟動：安裝 Flyto2 Runtime 依賴…"
  pnpm install --frozen-lockfile || fail "依賴安裝失敗。"
fi

needs_build=0
if [[ ! -f dist/cli.js ]]; then
  needs_build=1
elif find src package.json tsconfig.build.json vite.config.ts -type f -newer dist/cli.js -print -quit 2>/dev/null | grep -q .; then
  needs_build=1
fi
if [[ "$needs_build" == 1 ]]; then
  echo "更新 Flyto2 Runtime 執行檔…"
  pnpm build || fail "Build 失敗。"
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

printf '\n按 Enter 關閉視窗。'
read -r _
exit "$result"
