#!/usr/bin/env bash
# Where hono-hello's program starts, and the one driver flag it needs.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
"$here/../transpile.sh" apps/hono-hello/server.ts --globals
