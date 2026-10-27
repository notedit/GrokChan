#!/usr/bin/env bash
# Desktop preview of the character UI (no hardware).
#   tools/preview/run_preview.sh           build face_dump, write dist/preview_data.js
#   tools/preview/run_preview.sh --png     ... and render PNGs into docs/images with headless Chrome
# Needs a C++17 compiler (CXX, default g++); --png needs Chrome/Chromium (CHROME) and python3 + Pillow.
# Then open tools/preview/preview.html in any browser for the live animation.
set -euo pipefail
cd "$(dirname "$0")/../.."
CXX=${CXX:-g++}
CHROME=${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}
mkdir -p .build tools/preview/dist docs/images
$CXX -std=gnu++17 -O1 -Wall -Ilib/grokchan_core/src tools/preview/face_dump.cpp lib/grokchan_core/src/gc_face.cpp -o .build/face_dump
.build/face_dump tools/preview/dist/preview_data.js
echo "wrote tools/preview/dist/preview_data.js"
[ "${1:-}" = "--png" ] || { echo "open tools/preview/preview.html"; exit 0; }
[ -n "$CHROME" ] || { echo "no Chrome/Chromium found (set CHROME=...)" >&2; exit 1; }
PAGE="file://$PWD/tools/preview/preview.html"
shot() {  # shot <query> <out.png>
  local q="$1" out="$2" dims w h
  dims=$("$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=1500,1200 \
        --virtual-time-budget=3000 --dump-dom "$PAGE?$q" 2>/dev/null | grep -o 'data-w="[0-9]*" data-h="[0-9]*"' | head -1)
  w=$(echo "$dims" | sed 's/.*data-w="\([0-9]*\)".*/\1/'); h=$(echo "$dims" | sed 's/.*data-h="\([0-9]*\)".*/\1/')
  "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size="$w,$((h+130))" \
        --virtual-time-budget=3000 --screenshot="$out" "$PAGE?$q" >/dev/null 2>&1
  python3 - "$out" "$w" "$h" <<'PY'
import sys
from PIL import Image
p, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
Image.open(p).crop((0, 0, w, h)).save(p)
PY
  echo "wrote $out (${w}x${h})"
}
for s in idle listening thinking speaking; do shot "view=single&set=states&name=$s&s=2" "docs/images/state-$s.png"; done
shot "view=grid&set=states" docs/images/states-montage.png
shot "view=grid&set=exprs" docs/images/expressions-montage.png
shot "view=grid&set=layouts" docs/images/text-layouts.png
shot "view=grid&set=strips" docs/images/transitions.png
