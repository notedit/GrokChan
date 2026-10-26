#!/usr/bin/env bash
# Bridge <-> firmware-core end-to-end test (host only, no hardware).
# Needs: a C++17 compiler, Node 22 with bridge/node_modules installed, and `pio test -e native`
# run once (it fetches ArduinoJson into .pio/libdeps/native).
set -euo pipefail
cd "$(dirname "$0")/.."
AJ=${ARDUINOJSON_DIR:-.pio/libdeps/native/ArduinoJson/src}
CXX=${CXX:-g++}
mkdir -p .build
$CXX -std=gnu++17 -O1 -Wall -Ilib/grokchan_core/src -I"$AJ" tools/sim/sim_stdio.cpp lib/grokchan_core/src/*.cpp -o .build/sim_stdio
cd ../bridge
exec node_modules/.bin/vitest run --config ../firmware/tools/e2e/vitest.config.ts "$@"
