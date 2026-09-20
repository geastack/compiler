#!/usr/bin/env bash
# node-compat's v2 build driver, which is how anything in that repository gets
# turned into C++ and linked. Usage: transpile.sh <entry> [driver args...]
#
# NODE_COMPAT_DIR defaults to the path the workflow checks the repository out
# to, so the same script runs against a local clone.
set -euo pipefail

cd "${NODE_COMPAT_DIR:-node-compat}"
node scripts/build-v2.mjs "$@"
