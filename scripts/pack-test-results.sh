#!/usr/bin/env bash
set -euo pipefail
OUT="${1:-test-results-debug-light.zip}"
SRC="${2:-test-results}"
WORK="test-results-share"
rm -rf "$WORK" "$OUT"
mkdir -p "$WORK/screens" "$WORK/reports"
if [ ! -d "$SRC" ]; then
  echo "No $SRC directory found. Run npm run test:e2e first." >&2
  exit 1
fi
# Convert all PNG screenshots to compressed JPG files with stable names.
i=0
while IFS= read -r f; do
  i=$((i+1))
  base=$(basename "$f" .png | tr -cd '[:alnum:]_.-')
  [ -n "$base" ] || base="screenshot"
  if command -v sips >/dev/null 2>&1; then
    sips -Z 1400 -s format jpeg -s formatOptions 55 "$f" --out "$WORK/screens/${i}-${base}.jpg" >/dev/null
  else
    cp "$f" "$WORK/screens/${i}-${base}.png"
  fi
done < <(find "$SRC" -type f -name "*.png" | sort)
# Copy lightweight diagnostic reports.
while IFS= read -r f; do
  safe=$(echo "$f" | sed 's#[/ ]#_#g' | tr -cd '[:alnum:]_.-')
  cp "$f" "$WORK/reports/$safe"
done < <(find "$SRC" -type f \( -name "*.json" -o -name "*.md" -o -name "*.txt" \) ! -name "*.webm" ! -name "*.mp4" ! -name "trace.zip" | sort)
zip -r "$OUT" "$WORK" >/dev/null
ls -lh "$OUT"
