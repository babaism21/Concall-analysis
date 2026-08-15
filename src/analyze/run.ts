import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLES_DIR, MODEL_ID, PROMPT_VERSION, TRANSCRIPT_CHAR_CAP } from "../config.ts";
import { getDb, nowIso } from "../db.ts";
import { getLlmClient } from "../llm.ts";
import { ingestSymbol, loadParsedTranscripts } from "../ingest/run.ts";
import {
  HEALTHCHECK_SYSTEM,
  JSON_EXTRACT_SYSTEM,
  buildHealthcheckUserPrompt,
  buildJsonExtractPrompt,
} from "./prompts.ts";
import {
  type Commitment,
  type PortfolioJson,
  type TimelineEntry,
  normalizeStatus,
  parseCommitmentsFromMarkdown,
  parseRedFlagsFromMarkdown,
  scoreFromCommitments,
} from "./score.ts";

export type AnalysisRecord = {
  symbol: string;
  markdown: string;
  portfolioJson: PortfolioJson;
  latestSourceUrl: string | null;
  transcriptCount: number;
  modelId: string | null;
  promptVersion: string | null;
  createdAt: string;
  updatedAt: string;
  cacheHit: boolean;
  /** db = SQLite cache, example = bundled sample, fresh = just analyzed */
  source?: "db" | "example" | "fresh";
  /** True when a newer concall exists but we returned older cache (no API key / not forced). */
  updateAvailable?: boolean;
};

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
  return {
    ...row,
    portfolioJson: JSON.parse(row.portfolioJson) as PortfolioJson,
    cacheHit: true,
    source: "db",
  };
}

/** Bundled sample under examples/{SYMBOL}.json (+ optional .md). No API key. */
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
    timeline: raw.timeline ?? [],
    summary: raw.summary ?? "",
    transcriptCount: Number(raw.transcriptCount ?? 0),
    latestSourceUrl,
    scoredAt: ts,
  };
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

function normalizeCommitments(raw: unknown[]): Commitment[] {
  const out: Commitment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const status = normalizeStatus(String(o.status ?? ""));
    if (!status) continue;
    out.push({
      quarter: String(o.quarter ?? ""),
      commitment: String(o.commitment ?? ""),
      status,
      evidence: String(o.evidence ?? ""),
    });
  }
  return out;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON object in model response");
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

async function runLlmHealthcheck(
  symbol: string,
  transcripts: Array<{ fyQuarter: string; callDate: string; text: string }>
): Promise<{ markdown: string; extracted: Record<string, unknown> }> {
  const client = getLlmClient();
  console.log(`[analyze] LLM healthcheck ${symbol} (${transcripts.length} calls, model=${MODEL_ID})`);

  const mdResp = await client.chat.completions.create({
    model: MODEL_ID,
    temperature: 0.2,
    max_tokens: 8192,
    messages: [
      { role: "system", content: HEALTHCHECK_SYSTEM },
      {
        role: "user",
        content: buildHealthcheckUserPrompt(symbol, transcripts),
      },
    ],
  });
  const choice = mdResp.choices[0];
  const markdown = choice?.message?.content?.trim() ?? "";
  if (!markdown) {
    throw new Error(
      `Empty healthcheck markdown (finish=${choice?.finish_reason ?? "?"} refusal=${choice?.message?.refusal ?? "none"})`
    );
  }
  console.log(
    `[analyze] healthcheck tokens in=${mdResp.usage?.prompt_tokens ?? "?"} out=${mdResp.usage?.completion_tokens ?? "?"} finish=${choice?.finish_reason}`
  );

  console.log(`[analyze] LLM JSON extract ${symbol}`);
  let extracted: Record<string, unknown> = {};
  try {
    const jsonResp = await client.chat.completions.create({
      model: MODEL_ID,
      temperature: 0,
      max_tokens: 4096,
      messages: [
        { role: "system", content: JSON_EXTRACT_SYSTEM },
        { role: "user", content: buildJsonExtractPrompt(markdown) },
      ],
    });
    const raw = jsonResp.choices[0]?.message?.content?.trim() ?? "{}";
    console.log(
      `[analyze] json tokens in=${jsonResp.usage?.prompt_tokens ?? "?"} out=${jsonResp.usage?.completion_tokens ?? "?"} finish=${jsonResp.choices[0]?.finish_reason}`
    );
    extracted = extractJsonObject(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[analyze] JSON extract failed, using markdown fallback: ${msg}`);
    extracted = {};
  }
  return { markdown, extracted };
}

export async function analyzeSymbol(
  symbol: string,
  opts: { force?: boolean } = {}
): Promise<AnalysisRecord> {
  const sym = symbol.trim().toUpperCase();
  console.log(`[analyze] start ${sym} force=${Boolean(opts.force)}`);

  // Prefer existing DB/example before network — Show path should not need this,
  // but Update still discovers newest URL via ingest.
  let cached = getCached(sym);
  if (!cached) {
    const example = loadExample(sym);
    if (example) {
      saveAnalysis(example);
      cached = { ...example, source: "db", cacheHit: true };
      console.log(`[analyze] seeded DB from examples/${sym}.json`);
    }
  }

  const ingest = await ingestSymbol(sym);
  const transcripts = loadParsedTranscripts(sym);
  const latestUrl = transcripts[0]?.sourceUrl ?? ingest.latestSourceUrl;

  if (!transcripts.length) {
    if (cached) {
      console.log(`[analyze] no transcripts; returning prior cache for ${sym}`);
      return { ...cached, cacheHit: true, updateAvailable: false };
    }
    throw new Error(`No parsed transcripts for ${sym} (discovered=${ingest.discovered})`);
  }

  // Same newest concall as last analysis → return cache (no LLM, no API key).
  if (
    !opts.force &&
    cached &&
    cached.latestSourceUrl &&
    cached.latestSourceUrl === latestUrl
  ) {
    console.log(`[analyze] cache hit ${sym} (no new concall)`);
    return { ...cached, cacheHit: true, updateAvailable: false, source: "db" };
  }

  const needsLlm = true;
  if (needsLlm && !process.env.OPENROUTER_API_KEY) {
    if (cached) {
      console.log(
        `[analyze] update available for ${sym} but no OPENROUTER_API_KEY — returning stale cache`
      );
      return { ...cached, cacheHit: true, updateAvailable: true, source: "db" };
    }
    throw new Error(
      "No saved analysis yet. Set OPENROUTER_API_KEY in .env to run the first analysis (then it is cached until a new concall)."
    );
  }

  console.log(
    `[analyze] cache miss ${sym} — running LLM (force=${Boolean(opts.force)} priorUrl=${cached?.latestSourceUrl ?? "none"} newUrl=${latestUrl})`
  );

  const { markdown, extracted } = await runLlmHealthcheck(
    sym,
    transcripts.map((t) => ({
      fyQuarter: t.fyQuarter,
      callDate: t.callDate,
      text:
        t.text.length > TRANSCRIPT_CHAR_CAP
          ? t.text.slice(0, TRANSCRIPT_CHAR_CAP) +
            "\n\n[... truncated for analysis context ...]"
          : t.text,
    }))
  );

  let commitments = normalizeCommitments(
    Array.isArray(extracted.commitments) ? (extracted.commitments as unknown[]) : []
  );
  if (commitments.length < 3) {
    commitments = parseCommitmentsFromMarkdown(markdown);
  }

  let redFlags = Array.isArray(extracted.redFlags)
    ? (extracted.redFlags as unknown[]).map(String)
    : [];
  if (!redFlags.length) redFlags = parseRedFlagsFromMarkdown(markdown);

  const timeline = Array.isArray(extracted.timeline)
    ? (extracted.timeline as unknown[])
        .map((t) => {
          const o = t as Record<string, unknown>;
          return {
            quarter: String(o.quarter ?? ""),
            score: Number(o.score ?? 0),
            note: String(o.note ?? ""),
          } satisfies TimelineEntry;
        })
        .filter((t) => t.quarter)
    : [];

  const { healthScore, label } = scoreFromCommitments(commitments);
  const rawScore =
    typeof extracted.rawScore === "number"
      ? extracted.rawScore
      : timeline.length
        ? Math.round(
            (timeline.reduce((a, b) => a + b.score, 0) / timeline.length) * 10
          ) / 10
        : null;

  const portfolioJson: PortfolioJson = {
    symbol: sym,
    healthScore,
    label,
    rawScore,
    redFlags,
    commitments,
    timeline,
    summary: String(extracted.summary ?? "").trim(),
    transcriptCount: transcripts.length,
    latestSourceUrl: latestUrl,
    scoredAt: nowIso(),
  };

  const createdAt = cached?.createdAt ?? nowIso();
  const record: Omit<AnalysisRecord, "cacheHit" | "source" | "updateAvailable"> = {
    symbol: sym,
    markdown,
    portfolioJson,
    latestSourceUrl: latestUrl,
    transcriptCount: transcripts.length,
    modelId: MODEL_ID,
    promptVersion: PROMPT_VERSION,
    createdAt,
    updatedAt: nowIso(),
  };
  saveAnalysis(record);
  console.log(
    `[analyze] saved ${sym} score=${healthScore} (${label}) commitments=${commitments.length}`
  );
  return { ...record, cacheHit: false, source: "fresh", updateAvailable: false };
}

/**
 * Read-only. Never calls the LLM.
 * Order: SQLite → bundled examples/{SYMBOL}.json (seeded into DB on hit).
 */
export function getAnalysis(symbol: string): AnalysisRecord | null {
  const sym = symbol.trim().toUpperCase();
  const cached = getCached(sym);
  if (cached) return cached;

  const example = loadExample(sym);
  if (!example) return null;

  saveAnalysis(example);
  console.log(`[analyze] seeded DB from examples/${sym}.json (get)`);
  return { ...getCached(sym)!, source: "example", cacheHit: true };
}
