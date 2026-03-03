#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${APP_DIR}"

# Self-heal missing production deps before launch (prevents MODULE_NOT_FOUND boot loops).
if [ ! -f "node_modules/discord.js/package.json" ]; then
  echo "[start-bot] discord.js missing; running npm ci..."
  npm ci --omit=dev
fi

exec node index.js
