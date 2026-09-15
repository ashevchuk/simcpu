#!/usr/bin/env bash
# Build the double-clickable file:// bundle into dist-file/.
# Open dist-file/index.html from disk after this finishes.
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx vite build --config vite.config.file.ts
