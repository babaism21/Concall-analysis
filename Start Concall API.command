#!/bin/zsh
cd /Users/sonamsolanki/Desktop/Github/Concall-analysis || exit 1
export PATH="/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export ENABLE_ANALYZE_WORKER=false
export WORKER_CONCURRENCY=0
export PORT=8787
echo "Starting Concall API on http://127.0.0.1:8787 ..."
echo "Leave this window open. Press Ctrl+C to stop."
exec /usr/local/bin/node --experimental-strip-types src/cli.ts serve
