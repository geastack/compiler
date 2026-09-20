#!/usr/bin/env bash
# Write the run's summary. Usage: summarize.sh <title>
# Reads COMPILER_REF, NODE_COMPAT_REF and JOB_STATUS from the step's environment.
set -euo pipefail

{
  echo "### $1"
  echo
  echo "- compiler: \`$COMPILER_REF\`"
  echo "- node-compat: \`$NODE_COMPAT_REF\`"
  echo "- result: **$JOB_STATUS**"
} >> "$GITHUB_STEP_SUMMARY"
