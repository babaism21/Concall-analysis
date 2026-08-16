import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestSymbol } from "./ingest/run.ts";
import { analyzeSymbol, getAnalysis } from "./analyze/run.ts";
import { refreshSymbol } from "./ingest/refresh.ts";
import { startServer } from "./api/server.ts";
import { migrateSqliteToPostgres } from "./db/migrate.ts";
import { runWorkerLoopOnce } from "./jobs/worker.ts";
import { enqueueAnalyzeJob } from "./jobs/queue.ts";

function loadEnv() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function usage() {
  console.log(`Usage:
  npm run ingest -- SYMBOL
  npm run reparse -- SYMBOL   # force full PDF→text refresh
  npm run analyze -- SYMBOL [--force]   # incremental (hash cache); --force re-LLMs all
  npm run get -- SYMBOL
  npm run serve               # API + background analyze worker
  npm run worker              # drain analyze job queue once
  npm run migrate:pg
`);
}

async function main() {
  loadEnv();
  // Also try sibling portfolio .env for local dogfood (never committed here)
  const portfolioEnv = join(dirname(fileURLToPath(import.meta.url)), "../../.env");
  if (existsSync(portfolioEnv) && !process.env.OPENROUTER_API_KEY) {
    for (const line of readFileSync(portfolioEnv, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("OPENROUTER_API_KEY=")) continue;
      process.env.OPENROUTER_API_KEY = trimmed.slice("OPENROUTER_API_KEY=".length).trim();
    }
  }

  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    usage();
    process.exit(1);
  }

  if (cmd === "serve") {
    startServer();
    return;
  }

  if (cmd === "migrate:pg") {
    await migrateSqliteToPostgres();
    return;
  }

  if (cmd === "worker") {
    await runWorkerLoopOnce();
    return;
  }

  if (cmd === "enqueue") {
    const force = rest.includes("--force");
    const symbol = rest.find((a) => !a.startsWith("--"));
    if (!symbol) {
      usage();
      process.exit(1);
    }
    const job = enqueueAnalyzeJob(symbol, { force });
    console.log(JSON.stringify(job, null, 2));
    return;
  }

  const force = rest.includes("--force");
  const symbol = rest.find((a) => !a.startsWith("--"));
  if (!symbol) {
    usage();
    process.exit(1);
  }

  if (cmd === "ingest") {
    const result = await ingestSymbol(symbol);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "reparse") {
    const result = await ingestSymbol(symbol, undefined, { forceReparse: true });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "analyze") {
    const result = await analyzeSymbol(symbol, { force });
    console.log(
      JSON.stringify(
        {
          symbol: result.symbol,
          cacheHit: result.cacheHit,
          healthScore: result.portfolioJson.healthScore,
          label: result.portfolioJson.label,
          rawScore: result.portfolioJson.rawScore,
          redFlags: result.portfolioJson.redFlags,
          commitments: result.portfolioJson.commitments.length,
          transcriptCount: result.transcriptCount,
        },
        null,
        2
      )
    );
    return;
  }

  if (cmd === "get") {
    const cached = await getAnalysis(symbol);
    if (!cached) {
      console.error(`No cached analysis for ${symbol.toUpperCase()}`);
      process.exit(2);
    }
    console.log(JSON.stringify(cached.portfolioJson, null, 2));
    return;
  }

  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
