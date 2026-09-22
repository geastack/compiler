#!/usr/bin/env bash
# node-compat's build driver, which is how anything in that repository gets
# turned into C++ and linked. Usage: transpile.sh <entry> [driver args...]
#
# NODE_COMPAT_DIR defaults to the path the workflow checks the repository out
# to, so the same script runs against a local clone. The driver resolves
# `@geastack/compiler` from node-compat's own node_modules, which install.sh
# points at the checkout under test.
#
# The driver links with `-Os -flto` under clang, and LTO under clang on Linux
# needs the gold plugin. A runner without LLVMgold.so still builds -- without
# LTO, and says so -- rather than failing on a linker it never had.
set -euo pipefail

if [ "$(uname -s)" = Linux ] && [ "${GEA_LTO:-}" != 0 ] && ! ls /usr/lib/llvm-*/lib/LLVMgold.so >/dev/null 2>&1; then
  echo '::notice::no LLVMgold.so on this runner; building without LTO'
  export GEA_LTO=0
fi

cd "${NODE_COMPAT_DIR:-node-compat}"
node scripts/build.mjs "$@"
