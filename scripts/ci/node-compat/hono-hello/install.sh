#!/usr/bin/env bash
# What the build needs installed: node-compat's own dependencies, the
# unmodified hono package from npm, and the compiler under test.
#
# `npm ci` in node-compat installs the PUBLISHED compiler its lockfile names;
# the build driver resolves `@geastack/compiler` from that node_modules, so the
# installed copy is replaced with a link to the checkout beside it -- the same
# link a development tree carries. Without it the job would certify whatever
# the registry served, not the commit it was asked about.
set -euo pipefail

node_compat=$(cd "${NODE_COMPAT_DIR:-node-compat}" && pwd)
compiler=$(cd "${COMPILER_DIR:-compiler}" && pwd)

cd "$node_compat"
npm ci --ignore-scripts
rm -rf node_modules/@geastack/compiler
mkdir -p node_modules/@geastack
ln -s "$compiler" node_modules/@geastack/compiler
node -e 'console.log("@geastack/compiler ->", require.resolve("@geastack/compiler/package.json"))'

cd "$node_compat/apps/hono-hello"
npm ci --ignore-scripts
