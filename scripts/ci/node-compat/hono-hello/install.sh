#!/usr/bin/env bash
# hono-hello's own dependencies: the unmodified hono package, from npm.
set -euo pipefail

cd "${NODE_COMPAT_DIR:-node-compat}/apps/hono-hello"
npm ci --ignore-scripts
