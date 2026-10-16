#!/usr/bin/env bash
set -euo pipefail
: "${GEA_CORE_ROOT:?Actual coherent Core source root required}"
ROOT="$GEA_CORE_ROOT"
COMPILER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$COMPILER_ROOT/measurements/native-node-key-listener"
mkdir -p "$BUILD_DIR"
printf 'void __gea_top_level() {}\n' > "$BUILD_DIR/program.cpp"
CXX_BIN="${CXX:-clang++}"
export GEA_NATIVE_JOBS="${GEA_NATIVE_JOBS:-2}"
source "$ROOT/packages/core/test/native-test-common.sh"
gea_build_native_test "$BUILD_DIR" "$BUILD_DIR/native-node-key-listener-test" "$COMPILER_ROOT/test/runtime/native-node-key-listener.cpp" "-DGEA_TEST_RUNTIME_HEADER=\"$COMPILER_ROOT/src/targets/cpp/runtime/gea_runtime.h\""
status=0
for mode in unrelated removed disposer bubbling throw rotary stale-cleanup default nested; do
 if ! "$BUILD_DIR/native-node-key-listener-test" "$mode"; then status=1; fi
done
exit "$status"
