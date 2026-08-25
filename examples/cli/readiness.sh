#!/usr/bin/env bash
set -euo pipefail

sample_profile="${ANYPOINT_PROFILE:-default}"
sample_environment="${ANYPOINT_ENV:-Sandbox}"

if ! command -v anc >/dev/null 2>&1; then
    echo 'anc is not installed. Run: npm install --global @sfdxy/anypoint-connect' >&2
    exit 1
fi

echo "Checking profile: ${sample_profile}"
anc auth status --profile "${sample_profile}"

echo "Checking environment visibility: ${sample_environment}"
ANYPOINT_PROFILE="${sample_profile}" anc apps list --env "${sample_environment}"
