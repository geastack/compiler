#!/usr/bin/env bash
# What hono-hello must answer, byte for byte. The port is the one server.ts
# states (3900).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
"$here/../../shared/verify-routes.sh" \
  "${NODE_COMPAT_DIR:-node-compat}/apps/hono-hello/dist/server" 3900 \
  / 'Hello Hono!' \
  /json '{"hello":"world"}'
