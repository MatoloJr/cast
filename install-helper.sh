#!/usr/bin/env bash
# Backward-compatible wrapper — prefer ./install.sh
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" --helper-only "$@"
