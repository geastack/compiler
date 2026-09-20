#!/usr/bin/env bash
# Build a checked-out npm project. Usage: npm-build.sh <dir>
#
# `npm install`, not `npm ci`: the compiler's lockfile predates its `file:`
# dependencies on apple and core, so `ci` refuses it. Commit a synced lock and
# this becomes `ci`.
set -euo pipefail

cd "$1"
npm install --ignore-scripts
npm run build
