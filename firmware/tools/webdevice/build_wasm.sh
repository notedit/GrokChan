#!/usr/bin/env bash
# Build the firmware core (lib/grokchan_core) + the web HAL adapters into web/gc_core.wasm.
#   tools/webdevice/build_wasm.sh
# Needs a wasm32-wasi capable C++ compiler: either `zig` (zig c++), or clang with a wasi sysroot.
#   ZIG="python -m ziglang"  (pip install ziglang)  - default: `zig` from PATH
#   CXX=...                  to use another compiler command that already targets wasm32-wasi
# And ArduinoJson headers: `pio pkg install -e native` (default path below) or ARDUINOJSON_DIR=.../src.
# The prebuilt web/gc_core.wasm is committed so that running the web device needs no compiler;
# web/gc_core.sources.sha256 records what it was built from (checked by bridge/test/webdevice.test.ts).
set -euo pipefail
cd "$(dirname "$0")/../.."
AJ=${ARDUINOJSON_DIR:-.pio/libdeps/native/ArduinoJson/src}
[ -f "$AJ/ArduinoJson.h" ] || { echo "ArduinoJson not found at $AJ (run: pio pkg install -e native, or set ARDUINOJSON_DIR)" >&2; exit 1; }
if [ -n "${CXX:-}" ]; then COMPILE=($CXX); else COMPILE=(${ZIG:-zig} c++ -target wasm32-wasi); fi
OUT=tools/webdevice/web/gc_core.wasm
"${COMPILE[@]}" -mexec-model=reactor -Os -std=gnu++17 -fno-exceptions -fno-rtti -DNDEBUG \
  -Wall -Wno-unused-variable -Wl,--gc-sections -Wl,--strip-all \
  -Ilib/grokchan_core/src -I"$AJ" \
  tools/webdevice/web_platform.cpp lib/grokchan_core/src/gc_*.cpp -o "$OUT"
# Source fingerprint: the wasm must be rebuilt whenever the core or the adapters change.
( cat tools/webdevice/web_platform.cpp lib/grokchan_core/src/gc_*.cpp lib/grokchan_core/src/*.h | sha256sum | cut -d' ' -f1 ) > tools/webdevice/web/gc_core.sources.sha256
echo "built $OUT ($(wc -c < "$OUT") bytes), sources $(cut -c1-12 tools/webdevice/web/gc_core.sources.sha256)"
