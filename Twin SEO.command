#!/bin/bash
# Double-click this file in Finder to start Twin SEO.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  cat <<'MSG'

  Twin SEO needs Node.js, which is not installed on this Mac.

  Opening the download page. Take the "LTS" installer, run it,
  then double-click this file again.

MSG
  open "https://nodejs.org/en/download" 2>/dev/null
  read -r -p "  Press return to close. " _
  exit 1
fi

echo
echo "  Starting Twin SEO. Your browser will open in a moment."
echo "  Leave this window open while you use it; close it to stop."
echo

node "app/server.js" --open

echo
echo "  Twin SEO has stopped."
read -r -p "  Press return to close. " _
