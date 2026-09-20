#!/usr/bin/env bash
# What the runner actually provides. Printed before anything is built, so a
# version change shows up in the log above the failure it caused.
set -euo pipefail

node --version
npm --version
clang++ --version
