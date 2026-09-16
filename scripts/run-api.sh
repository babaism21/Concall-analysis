#!/bin/zsh
set -euo pipefail
cd /Users/sonamsolanki/Desktop/Github/Concall-analysis
export PATH="/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# Do NOT `source .env` here — Node loads it. Unquoted values break zsh.
export ENABLE_ANALYZE_WORKER=false
export WORKER_CONCURRENCY=0
NODE_BIN="$(command -v node)"
exec "$NODE_BIN" --experimental-strip-types src/cli.ts serve
