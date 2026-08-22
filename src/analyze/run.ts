import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLES_DIR, MODEL_ID, PROMPT_VERSION } from "../config.ts";
import { getDb, nowIso } from "../db.ts";
import { ingestSymbol, loadParsedTranscripts } from "../ingest/run.ts";
import { syncSymbolToPostgres } from "../db/sync.ts";
import { getStockFromPg, isPostgresEnabled } from "../db/pg.ts";
import { stockToAnalysisRecord } from "../db/read.ts";
import { analyzeAllTranscripts } from "./perCall.ts";
import { countMissingExtracts } from "../db/extractCache.ts";
import {
  attachTranscriptAnchors,
  buildInsightsFromCommitments,
  buildQuarterTimeline,
  repairFlatTimeline,
  scoreFromCommitments,
  type PortfolioJson,
} from "./score.ts";
import type { AnalysisRecord, TranscriptPayload } from "../types.ts";

function getCached(symbol: string): AnalysisRecord | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT symbol, markdown, portfolio_json as portfolioJson, latest_source_url as latestSourceUrl,
              transcript_count as transcriptCount, model_id as modelId, prompt_version as promptVersion,
              created_at as createdAt, updated_at as updatedAt
       FROM management_analysis WHERE symbol = ?`
    )
    .get(symbol.trim().toUpperCase()) as
    | {
        symbol: string;
        markdown: string;
        portfolioJson: string;
        latestSourceUrl: string | null;
        transcriptCount: number;
        modelId: string | null;
        promptVersion: string | null;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  if (!row) return null;
  let portfolioJson = JSON.parse(row.portfolioJson) as PortfolioJson;
  if (!portfolioJson.insights) portfolioJson.insights = [];
  portfolioJson = repairFlatTimeline(portfolioJson);
  return {
    ...row,
    portfolioJson,
    cacheHit: true,
    source: "db",
  };
}

function loadExample(symbol: string): AnalysisRecord | null {
  const sym = symbol.trim().toUpperCase();
  const jsonPath = join(EXAMPLES_DIR, `${sym}.json`);
  if (!existsSync(jsonPath)) return null;
  const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as PortfolioJson & {
    latestSourceUrl?: string;
  };
  const mdPath = join(EXAMPLES_DIR, `${sym}.md`);
  const markdown = existsSync(mdPath)
    ? readFileSync(mdPath, "utf8")
    : `# ${sym}\n\nBundled example analysis.`;
  const latestSourceUrl = raw.latestSourceUrl ?? null;
  const ts = raw.scoredAt || nowIso();
  const portfolioJson: PortfolioJson = {
    symbol: sym,
    healthScore: Number(raw.healthScore ?? 0),
    label: raw.label ?? "Weak",
    rawScore: raw.rawScore ?? null,
    redFlags: raw.redFlags ?? [],
    commitments: raw.commitments ?? [],
    insights: raw.insights ?? [],
    timeline: raw.timeline ?? [],
    summary: raw.summary ?? "",
    transcriptCount: Number(raw.transcriptCount ?? 0),
    latestSourceUrl,
    scoredAt: ts,
  };
  if (!portfolioJson.insights.length) {
    portfolioJson.insights = buildInsightsFromCommitments(
      portfolioJson.commitments,
      portfolioJson.redFlags
    );
  }
  return {
    symbol: sym,
    markdown,
    portfolioJson,
    latestSourceUrl,
    transcriptCount: portfolioJson.transcriptCount,
    modelId: "example",
    promptVersion: "example",
    createdAt: ts,
    updatedAt: ts,
    cacheHit: true,
    source: "example",
  };
}

function saveAnalysis(rec: Omit<AnalysisRecord, "cacheHit">) {
  const db = getDb();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO management_analysis (
       symbol, markdown, portfolio_json, latest_source_url, transcript_count,
       model_id, prompt_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       markdown = excluded.markdown,
       portfolio_json = excluded.portfolio_json,
       latest_source_url = excluded.latest_source_url,
       transcript_count = excluded.transcript_count,
       model_id = excluded.model_id,
       prompt_version = excluded.prompt_version,
       updated_at = excluded.updated_at`
  ).run(
    rec.symbol,
    rec.markdown,
    JSON.stringify(rec.portfolioJson),
    rec.latestSourceUrl,
    rec.transcriptCount,
    rec.modelId,
    rec.promptVersion,
    rec.createdAt || ts,
    ts
  );
}

function cacheIsFresh(cached: AnalysisRecord, latestUrl: string | null, transcriptCount: number): boolean {
  return (
    Boolean(cached.latestSourceUrl) &&
    cached.latestSourceUrl === latestUrl &&
    cached.promptVersion === PROMPT_VERSION &&
    cached.transcriptCount === transcriptCount
  );
}

function withTranscripts(rec: AnalysisRecord): AnalysisRecord {
  const rows = loadParsedTranscripts(rec.symbol);
  const transcripts: TranscriptPayload[] = rows.map((t) => ({
    callDate: t.callDate,
    fyQuarter: t.fyQuarter,
    sourceUrl: t.sourceUrl,
    text: t.text,
    charCount: t.charCount,
  }));
  const portfolioJson = attachTranscriptAnchors(rec.portfolioJson, transcripts);
  if (
    JSON.stringify(portfolioJson.insights) !== JSON.stringify(rec.portfolioJson.insights) ||
    !rec.portfolioJson.insights?.length
  ) {
    saveAnalysis({ ...rec, portfolioJson });
  }
  return {
    ...rec,
    portfolioJson,
    transcripts,
    transcriptCount: transcripts.length || rec.transcriptCount,
  };
}

export async function analyzeSymbol(
  symbol: string,
  opts: { force?: boolean; skipIngest?: boolean } = {}
): Promise<AnalysisRecord> {
  const sym = symbol.trim().toUpperCase();
  console.log(`[analyze] start ${sym} force=${Boolean(opts.force)} model=${MODEL_ID} prompt=${PROMPT_VERSION}`);

  let cached = getCached(sym);
  if (!cached) {
    const example = loadExample(sym);
    if (example) {
      saveAnalysis(example);
      cached = { ...example, source: "db", cacheHit: true };
      console.log(`[analyze] seeded DB from examples/${sym}.json`);
    }
  }

  // Prefer local transcripts for extract fill / cache hits. Only hit Screener when needed.
  let transcripts = loadParsedTranscripts(sym);
  const shouldIngest =
    !opts.skipIngest && (Boolean(opts.force) || transcripts.length === 0 || !cached);

  let latestUrl = transcripts[0]?.sourceUrl ?? cached?.latestSourceUrl ?? null;
  if (shouldIngest) {
    const ingest = await ingestSymbol(sym, undefined, { forceReparse: Boolean(opts.force) });
    transcripts = loadParsedTranscripts(sym);
    latestUrl = transcripts[0]?.sourceUrl ?? ingest.latestSourceUrl;
  } else {
    console.log(`[analyze] skip Screener ingest ${sym} (local transcripts=${transcripts.length})`);
  }

  if (!transcripts.length) {
    if (cached) {
      console.log(`[analyze] no transcripts; returning prior cache for ${sym}`);
      return withTranscripts({ ...cached, cacheHit: true, updateAvailable: false });
    }
    throw new Error(`No parsed transcripts for ${sym}`);
  }

  if (!opts.force && cached && cacheIsFresh(cached, latestUrl, transcripts.length)) {
    const missing = countMissingExtracts(transcripts);
    if (missing === 0) {
      console.log(`[analyze] cache hit ${sym} (no new concall, extracts complete)`);
      return withTranscripts({
        ...cached,
        cacheHit: true,
        updateAvailable: false,
        source: "db",
      });
    }
    console.log(`[analyze] ${sym} has ${missing} missing extracts — filling gaps`);
  }

  if (!process.env.OPENROUTER_API_KEY) {
    if (cached) {
      console.log(
        `[analyze] update available for ${sym} but no OPENROUTER_API_KEY — returning stale cache`
      );
      return withTranscripts({
        ...cached,
        cacheHit: true,
        updateAvailable: true,
        source: "db",
      });
    }
    throw new Error(
      "No saved analysis yet. Set OPENROUTER_API_KEY in .env to run the first analysis."
    );
  }

  console.log(
    `[analyze] incremental ${sym} — ${transcripts.length} transcripts (force=${Boolean(opts.force)} missing=${countMissingExtracts(transcripts)})`
  );

  const blocks = transcripts.map((t) => ({
    fyQuarter: t.fyQuarter,
    callDate: t.callDate,
    sourceUrl: t.sourceUrl,
    text: t.text,
  }));

  const { perCalls, synthesis, allInsights, llmCalls, cacheHits } = await analyzeAllTranscripts(
    sym,
    blocks,
    { force: Boolean(opts.force) }
  );

  const { healthScore, label } = scoreFromCommitments(synthesis.commitments);
  const scored =
    synthesis.commitments.length > 0
      ? { healthScore, label }
      : {
          healthScore: Math.round(
            (perCalls.reduce((a, c) => a + c.callScore, 0) / perCalls.length) * 10
          ),
          label: (perCalls.reduce((a, c) => a + c.callScore, 0) / perCalls.length >= 7.5
            ? "Good"
            : perCalls.reduce((a, c) => a + c.callScore, 0) / perCalls.length >= 5
              ? "Average"
              : "Weak") as PortfolioJson["label"],
        };

  let portfolioJson: PortfolioJson = {
    symbol: sym,
    healthScore: scored.healthScore,
    label: scored.label,
    rawScore: synthesis.rawScore,
    redFlags: synthesis.redFlags,
    commitments: synthesis.commitments,
    insights: allInsights,
    timeline: buildQuarterTimeline({
      calls: perCalls.map((c) => ({
        quarter: c.fyQuarter,
        callScore: c.callScore,
        summary: c.summary,
        positiveCount: c.insights.filter((i) => i.kind === "positive" || i.kind === "delivered").length,
        negativeCount: c.insights.filter((i) => i.kind === "negative" || i.kind === "missed").length,
        riskCount: c.insights.filter((i) => i.kind === "risk").length,
      })),
      commitments: synthesis.commitments,
      insights: allInsights,
      redFlags: synthesis.redFlags,
      llmNotes: synthesis.timeline,
    }),
    summary: synthesis.summary,
    transcriptCount: transcripts.length,
    latestSourceUrl: latestUrl,
    scoredAt: nowIso(),
  };
  portfolioJson = attachTranscriptAnchors(portfolioJson, transcripts);

  const createdAt = cached?.createdAt ?? nowIso();
  const record: Omit<AnalysisRecord, "cacheHit" | "source" | "updateAvailable" | "transcripts"> = {
    symbol: sym,
    markdown: synthesis.markdown,
    portfolioJson,
    latestSourceUrl: latestUrl,
    transcriptCount: transcripts.length,
    modelId: MODEL_ID,
    promptVersion: PROMPT_VERSION,
    createdAt,
    updatedAt: nowIso(),
  };
  saveAnalysis(record);
  try {
    await syncSymbolToPostgres(sym);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[analyze] Postgres sync failed for ${sym}: ${msg}`);
  }

  const byCall = perCalls.map((c) => `${c.fyQuarter}:${c.insights.length}`).join(", ");
  console.log(
    `[analyze] saved ${sym} score=${scored.healthScore} (${scored.label}) insights=${allInsights.length} llm=${llmCalls} cacheHits=${cacheHits} per-call=[${byCall}]`
  );

  return withTranscripts({
    ...record,
    cacheHit: false,
    source: "fresh",
    updateAvailable: false,
  });
}

export async function getAnalysis(symbol: string): Promise<AnalysisRecord | null> {
  const sym = symbol.trim().toUpperCase();

  if (isPostgresEnabled()) {
    try {
      const stock = await getStockFromPg(sym);
      const rec = stockToAnalysisRecord(stock);
      if (rec) return rec;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[analyze] Postgres read failed, falling back to SQLite: ${msg}`);
    }
  }

  let cached = getCached(sym);
  if (!cached) {
    const example = loadExample(sym);
    if (!example) return null;
    saveAnalysis(example);
    console.log(`[analyze] seeded DB from examples/${sym}.json (get)`);
    cached = { ...getCached(sym)!, source: "example", cacheHit: true };
    try {
      await syncSymbolToPostgres(sym);
    } catch {
      /* best effort */
    }
  }
  return withTranscripts(cached);
}
