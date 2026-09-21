#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_DIR}"

VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('manifest.json', 'utf8')).version)")"
OUTPUT_DIR="dist"
ARCHIVE="${OUTPUT_DIR}/foldnex-${VERSION}.zip"
CHECKSUM="${ARCHIVE}.sha256"

FILES=(
  manifest.json
  background.js
  popup.html
  popup.css
  popup.js
  options/options.html
  options/options.css
  options/options.js
  src/ai-engine.js
  src/cache-engine.js
  src/group-state.js
  src/grouper.js
  src/offline-clusterer.js
  src/site-clusterer.js
  icons/icon16.png
  icons/icon32.png
  icons/icon48.png
  icons/icon128.png
  icons/material-symbols-rounded.ttf
  icons/material-symbols-LICENSE.txt
)

for file in "${FILES[@]}"; do
  if [[ ! -f "${file}" ]]; then
    echo "Missing required package file: ${file}" >&2
    exit 1
  fi
done

mkdir -p "${OUTPUT_DIR}"
rm -f "${ARCHIVE}" "${CHECKSUM}"
zip -X -q "${ARCHIVE}" "${FILES[@]}"
unzip -tq "${ARCHIVE}"
shasum -a 256 "${ARCHIVE}" > "${CHECKSUM}"

echo "Created ${ARCHIVE}"
echo "Created ${CHECKSUM}"
