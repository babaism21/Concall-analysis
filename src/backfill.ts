import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { enqueueAnalyzeJob, type AnalysisJob } from "./jobs/queue.ts";
import { refreshSymbol } from "./ingest/refresh.ts";
import { countMissingExtracts } from "./db/extractCache.ts";
import { loadParsedTranscripts } from "./ingest/run.ts";
import { getDb } from "./db.ts";

export function loadUniverse(filePath: string): string[] {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`Universe file not found: ${abs}`);
  }
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(abs, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sym = trimmed.toUpperCase().replace(/[^A-Z0-9._-]/g, "");
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    symbols.push(sym);
  }
  return symbols;
}

export type BackfillMode = "enqueue" | "refresh" | "status";

export type BackfillResult = {
  mode: BackfillMode;
  file: string;
  symbols: string[];
  jobs?: AnalysisJob[];
  refresh?: Array<{
    symbol: string;
    parsed: number;
    synced: boolean;
    error?: string;
  }>;
  status?: Array<{
    symbol: string;
    hasAnalysis: boolean;
    transcripts: number;
    missingExtracts: number;
  }>;
};

export async function runBackfill(opts: {
  file: string;
  mode: BackfillMode;
  force?: boolean;
  limit?: number;
}): Promise<BackfillResult> {
  let symbols = loadUniverse(opts.file);
  if (opts.limit && opts.limit > 0) {
    symbols = symbols.slice(0, opts.limit);
  }

  if (opts.mode === "enqueue") {
    const jobs = symbols.map((sym) => enqueueAnalyzeJob(sym, { force: opts.force }));
    console.log(`[backfill] enqueued ${jobs.length} analyze jobs from ${opts.file}`);
    return { mode: "enqueue", file: opts.file, symbols, jobs };
  }

  if (opts.mode === "refresh") {
    const refresh: BackfillResult["refresh"] = [];
    for (const sym of symbols) {
      try {
        console.log(`[backfill] refresh ${sym}`);
        const r = await refreshSymbol(sym, { forceReparse: Boolean(opts.force) });
        refresh.push({ symbol: sym, parsed: r.parsed, synced: r.synced });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[backfill] refresh failed ${sym}: ${msg}`);
        refresh.push({ symbol: sym, parsed: 0, synced: false, error: msg });
      }
    }
    return { mode: "refresh", file: opts.file, symbols, refresh };
  }

  // status
  const db = getDb();
  const status = symbols.map((sym) => {
    const analysis = db
      .prepare(`SELECT 1 as ok FROM management_analysis WHERE symbol = ?`)
      .get(sym) as { ok: number } | undefined;
    const transcripts = loadParsedTranscripts(sym);
    return {
      symbol: sym,
      hasAnalysis: Boolean(analysis),
      transcripts: transcripts.length,
      missingExtracts: countMissingExtracts(transcripts),
    };
  });
  return { mode: "status", file: opts.file, symbols, status };
}
