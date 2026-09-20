#!/usr/bin/env bash
# What hono-hello must answer, byte for byte.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
"$here/../../shared/verify-routes.sh" \
  "${NODE_COMPAT_DIR:-node-compat}/apps/hono-hello/dist-v2/server" 3000 \
  / 'Hello Hono!' \
  /json '{"hello":"world"}'
