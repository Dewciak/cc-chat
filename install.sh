#!/usr/bin/env bash
# ClaudeChat installer — thin wrapper around setup.js
set -e
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "node is required (not found on PATH)"; exit 1; }
node setup.js
