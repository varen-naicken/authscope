#!/usr/bin/env bash
# Builds both browser packages from this one source folder.
#   dist/authscope-chrome.zip   unzip, then "Load unpacked" in chrome://extensions
#   dist/authscope-chrome-store.zip  upload this one to the Chrome Web Store
#   dist/authscope-firefox.xpi  Firefox package (manifest at the root, as Firefox expects)
set -euo pipefail
cd "$(dirname "$0")"
# The Chrome Web Store rejects a manifest description over 132 characters.
for m in manifest.json manifest.firefox.json; do
  n=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['description']))" "$m")
  if [ "$n" -gt 132 ]; then echo "$m: description is $n characters; the Chrome Web Store allows 132." >&2; exit 1; fi
done
FILES=(background.js popup.html popup.js dashboard.html dashboard.js README.md lib ui icons fonts brand)
rm -rf dist && mkdir -p dist/stage/authscope dist/stage/firefox

cp -r "${FILES[@]}" manifest.json dist/stage/authscope/
cp -r "${FILES[@]}" dist/stage/firefox/
cp manifest.firefox.json dist/stage/firefox/manifest.json

(cd dist/stage && zip -rqX ../authscope-chrome.zip authscope)
# Chrome Web Store upload: manifest.json must be at the top of the zip, not inside a folder.
(cd dist/stage/authscope && zip -rqX ../../authscope-chrome-store.zip .)
(cd dist/stage/firefox && zip -rqX ../../authscope-firefox.xpi .)
rm -rf dist/stage
ls -l dist
