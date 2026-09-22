#!/usr/bin/env bash
# Where hono-hello's program starts. The bare build is the one every published
# number was taken from; the binary lands at apps/hono-hello/dist/server.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
"$here/../transpile.sh" apps/hono-hello/server.ts
