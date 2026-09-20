#!/usr/bin/env bash
# Start a built binary, wait for it to listen, and compare each route's body
# byte for byte. The only check in this pipeline that reads the program's
# output rather than its exit status.
#
# Usage: verify-routes.sh <binary> <port> <path> <expected> [<path> <expected>...]
set -euo pipefail

if [ "$#" -lt 4 ] || [ $(("$#" % 2)) -ne 0 ]; then
  echo "::error::usage: verify-routes.sh <binary> <port> <path> <expected> [...]"
  exit 2
fi

binary=$1
base="http://127.0.0.1:$2"
shift 2

"$binary" &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT

wait_until_listening() {
  for _ in $(seq 50); do
    curl -fs "$base/" >/dev/null && return 0
    kill -0 "$server" 2>/dev/null || { echo '::error::server exited before it listened'; return 1; }
    sleep 0.2
  done
  echo '::error::server never listened'
  return 1
}

expect_route() {
  local body
  body=$(curl -fs "$base$1") || { echo "::error::GET $1 failed"; return 1; }
  [ "$body" = "$2" ] || { echo "::error::GET $1 -> $body (expected $2)"; return 1; }
  echo "GET $1 -> $body"
}

wait_until_listening
while [ "$#" -gt 0 ]; do
  expect_route "$1" "$2"
  shift 2
done
