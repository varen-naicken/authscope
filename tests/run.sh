#!/usr/bin/env bash
# Runs AuthScope's tests. Needs Node 18+, openssl, and Playwright's Chromium:
#   npm install && npx playwright install chromium && npm test
# The browser tests load the extension in Chromium and use fake provider pages
# served from this machine, so no real accounts are touched.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${TMPDIR:-/tmp}/authscope-tests"
mkdir -p "$OUT"

# The fake provider pages are served over HTTPS with a throwaway certificate.
if [ ! -f "$OUT/cert.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=localhost" \
    -keyout "$OUT/key.pem" -out "$OUT/cert.pem" 2>/dev/null
fi

# Load a clean copy of the extension (without tests/, site/ or node_modules/).
EXT="$OUT/ext"; rm -rf "$EXT"; mkdir -p "$EXT"
cp -r background.js mark.js popup.html popup.js dashboard.html dashboard.js manifest.json lib ui icons fonts brand "$EXT/"
export AUTHSCOPE_EXT="$EXT"

node tests/match.test.mjs
node tests/providers.test.mjs
for t in e2e sync-e2e select-e2e pie-e2e donate-e2e onboard-e2e mark-e2e; do
  echo "== $t"; node "tests/$t.cjs"
done
echo "All tests passed."
