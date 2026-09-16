#!/bin/zsh
set -euo pipefail
cd /Users/sonamsolanki/Desktop/Github/Concall-analysis
export PATH="/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export ENABLE_ANALYZE_WORKER=true
export WORKER_CONCURRENCY=1
export ANALYZE_CONCURRENCY=2
NODE_BIN="$(command -v node)"
exec "$NODE_BIN" --experimental-strip-types src/cli.ts worker --loop
