#!/bin/zsh
cd /Users/sonamsolanki/Desktop/Github/Concall-analysis || exit 1
export PATH="/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export ENABLE_ANALYZE_WORKER=true
export WORKER_CONCURRENCY=1
echo "Starting Concall analyze worker (1 at a time)..."
echo "Leave this window open. Press Ctrl+C to stop."
exec /usr/local/bin/node --experimental-strip-types src/cli.ts worker --loop
