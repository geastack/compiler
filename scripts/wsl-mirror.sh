#!/usr/bin/env bash
# Mirror this Mac compiler tree (and optionally one app) onto the WSL build
# machine and run commands there, so suites, gates and native compiles do not
# load the Mac.
#
# The Mac tree is authoritative. rsync --delete makes WSL's compiler sources
# (and core, native-webgl-angle, node-compat, parallel, benchmarks) match this tree; WSL's node_modules/, dist/ and measurements/ (and the
# gitignored vendor/ checkouts) are left alone. dist/ is rebuilt clean there.
#
#   scripts/wsl-mirror.sh                    # sync + rebuild dist on WSL
#   scripts/wsl-mirror.sh --no-build         # sync only
#   scripts/wsl-mirror.sh -- <cmd...>        # sync + rebuild, then run <cmd> in ~/geastack/compiler
#   scripts/wsl-mirror.sh --run -- <cmd...>  # no sync, run <cmd> against the dist already there
#   scripts/wsl-mirror.sh --app <name>       # also sync ../<name> and compile it (certify) on WSL
#
# BUILD_CPUS defaults to every core (0-19): the narrow pin left the VM half idle
# while agents queued. Pass a narrower BUILD_CPUS while a benchmark is measuring.
# Every command runs in a memory-capped cgroup (WSL_MEMORY_MAX, default 12G; 16G
# for an app compile) inside geastack.slice, which caps all of them together at 17G
# (`systemctl --user set-property geastack.slice MemoryMax=17G`). WSL has 19 GB,
# and one runaway process (node:assert diffing two syntax trees) has taken the
# whole VM down for every agent.
#
# An app's generated module graph names absolute Mac paths, so it is mirrored
# to the same absolute path on WSL and compiled against ~/geastack/compiler/dist.
#
# Source replacement and the rebuild hold ~/geastack-tree.lock exclusively;
# commands run through wsl-read.sh (writer gate + shared tree lock), so
# concurrent mirrors serialize and readers never see a half-replaced tree.
set -euo pipefail

HOST=dashwin-geastack
BUILD_CPUS=${BUILD_CPUS:-0-19}
WSL_RSYNC='wsl -d Ubuntu-24.04 -- flock -x /home/dashersw/geastack-tree.lock rsync'
here=$(cd "$(dirname "$0")/.." && pwd)
geastack=$(cd "$here/.." && pwd)
sync=1
build=1
app=
cmd=()
while [ $# -gt 0 ]; do
  case $1 in
    --no-build) build=0 ;;
    --run) sync=0; build=0 ;;
    --app) shift; app=${1:?--app needs an app directory name} ;;
    --) shift; cmd=("$@"); break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

wsl() { ssh "$HOST" 'wsl -d Ubuntu-24.04 -- bash -s'; }
mirror() { rsync -a --delete --mkpath --rsync-path="$WSL_RSYNC" -e ssh "$@"; }

if [ $sync = 1 ]; then
  # A test fixture's own node_modules IS the fixture (a package the test
  # resolves), not installed dependencies; dropping it failed those tests on WSL.
  mirror \
    --include='/test/fixtures/commonjs-module-record/**' \
    --exclude=.git --exclude=.DS_Store --exclude=node_modules \
    --exclude=/dist --exclude=/measurements --exclude=/vendor --exclude=/cloud-run-ts-sweep \
    --exclude=/cr-gen3 --exclude=/projects --exclude=/.scratch --exclude='*.orig' --exclude='*.rej' \
    "$here/" "$HOST:/home/dashersw/geastack/compiler/"
  # The @geastack packages (plugins, runtime headers) are what the tests compile
  # against and drift between machines; mirror them too. -L because some are
  # symlinks to sibling checkouts on the Mac.
  mirror -L --exclude=node_modules --exclude=.git "$here/node_modules/@geastack/" \
    "$HOST:/home/dashersw/geastack/compiler/node_modules/@geastack/"
  # Sibling checkouts the tests include headers from (core) and the benchmarks
  # build (node-compat, parallel, benchmarks), and every package the release
  # suite tests (examples, cli, targets, simulator, windows, debugger, apple).
  # Gitignored build output and WSL's
  # own results stay put; benchmarks keeps WSL's package.json stub and lock.
  for d in core native-webgl-angle node-compat parallel benchmarks examples demos cli targets simulator windows debugger apple; do
    extra=()
    [ $d = benchmarks ] && extra=(--exclude=/package.json --exclude=/package-lock.json --exclude=results/)
    mirror --include=.env.example --filter=':- .gitignore' --exclude=.git --exclude=node_modules --exclude=.DS_Store "${extra[@]}" \
      "$geastack/$d/" "$HOST:/home/dashersw/geastack/$d/"
  done
  echo "compiler mirrored"
fi

if [ $build = 1 ]; then
  wsl <<'EOF'
set -euo pipefail
. ~/.nvm/nvm.sh >/dev/null
cd ~/geastack/compiler
# Clean build: tsc never deletes output for removed sources, and a stale
# tsbuildinfo can skip emitting files dist/ no longer has.
flock -x ~/geastack-tree.lock bash -c 'rm -rf dist measurements/.tsbuildinfo; npx tsc -p tsconfig.json'
echo "dist rebuilt"
EOF
fi

if [ -n "$app" ]; then
  s=$geastack/$app
  mirror --exclude=.git --exclude=.DS_Store --exclude=/dist --exclude=/xbox --exclude=/docs --exclude=/windows \
    "$s/" "$HOST:$s/"
  mirror "$s/dist/macos/.generated/$app/" "$HOST:$s/dist/macos/.generated/$app/"
  wsl <<EOF
set -uo pipefail
. ~/.nvm/nvm.sh >/dev/null
${BUILD_CPUS:+export BUILD_CPUS=$BUILD_CPUS}
S=$s; G=\$S/dist/macos/.generated/$app
cd \$S
# One app compile at a time: a large one peaks near 14 GB of WSL's 19 GB, and two
# at once have taken the VM down.
flock ~/geastack-app-compile.lock /usr/bin/time -f '$app compile: %e s wall, %M KB max RSS' \
  systemd-run --user --scope -q --slice=geastack.slice -p MemoryMax=${WSL_MEMORY_MAX:-16G} -p MemorySwapMax=0 ~/geastack/wsl-read.sh node --stack_size=8192 --max-old-space-size=16384 \
  ~/geastack/compiler/dist/cli.js compile-module-graph \$G/module-graph/gea-module-graph.json --out-dir \$G \
  --plugin \$S/node_modules/@geastack/geatsc-plugin-gea/dist/index.js --plugin-option gea.ir=\$G/dist/gea-ir.json \
  --plugin-option gea.microtasks-namespace=gea::framework::app::generated --entry \$S/index.tsx --module-graph-stage hybrid \
  --plugin \$S/node_modules/@geastack/geatsc-plugin-apple-native/dist/index.js --plugin-option apple.metadata=\$G/gea-apple-metadata.json \
  --plugin \$S/node_modules/@geastack/native-webgl-angle/geatsc-plugin.mjs --plugin-option gea.store-relowering=true 2>&1 | cut -c1-600
EOF
fi

if [ ${#cmd[@]} -gt 0 ]; then
  quoted=$(printf '%q ' "${cmd[@]}")
  # Killing this script only drops the ssh session; the WSL side keeps running
  # and holds the tree lock. The command runs in a named scope that the trap
  # stops, which takes every process in its cgroup with it.
  unit=geastack-mirror-$$-$RANDOM
  # A completed scope has already disappeared. Its cleanup must not replace
  # the command's status with systemctl's "unit not found" exit code.
  trap "echo 'systemctl --user stop $unit.scope 2>/dev/null' | wsl >/dev/null 2>&1 || true" EXIT INT TERM HUP
  wsl <<EOF
set -uo pipefail
. ~/.nvm/nvm.sh >/dev/null
export PATH=\$HOME/.cargo/bin:\$PATH
cd ~/geastack/compiler
${BUILD_CPUS:+export BUILD_CPUS=$BUILD_CPUS}
systemd-run --user --scope -q --unit=$unit --slice=geastack.slice -p MemoryMax=${WSL_MEMORY_MAX:-12G} -p MemorySwapMax=0 ~/geastack/wsl-read.sh $quoted
EOF
fi
