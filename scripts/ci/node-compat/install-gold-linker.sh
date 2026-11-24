#!/usr/bin/env bash
# The driver links clang's full LTO on Linux through ld.gold. Ubuntu 26.04
# ships the gold plugin with clang but keeps ld.gold in its own package, so
# without this CI would build a binary without LTO, unlike a real build.
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y -qq binutils-gold
ld.gold --version | head -1
