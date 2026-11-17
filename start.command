#!/bin/bash
# Double-click this file in Finder to start webtorent.
# Everything it needs lives in this folder - no global installs.
set -u
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-5173}"

if [ ! -d node_modules ] || [ ! -d node_modules/webtorrent ]; then
  echo "First run: installing dependencies into ./node_modules …"
  # --cache keeps npm from writing to the (often root-owned) global cache.
  npm install --cache ./.npm-cache --no-audit --no-fund || {
    echo
    echo "npm install failed. If it complains about permissions in ~/.npm, run:"
    echo "  sudo chown -R \$(id -u):\$(id -g) ~/.npm"
    echo
    read -r -p "Press return to close…"
    exit 1
  }
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo
  echo "NOTE: ffmpeg was not found. MP4 files will still play,"
  echo "      but MKV/AVI need it:  brew install ffmpeg"
  echo
fi

# Open the browser once the server is up.
( sleep 2; open "http://127.0.0.1:${PORT}" >/dev/null 2>&1 ) &

if [ -z "${OPENSUBTITLES_API_KEY:-}" ]; then
  echo "Tip: set OPENSUBTITLES_API_KEY to search/download subtitles online."
  echo "     (subtitles already inside a file work without it)"
  echo
fi

echo "Starting webtorent on http://127.0.0.1:${PORT}"
echo "Press Ctrl+C to stop."
echo
exec node server.js
