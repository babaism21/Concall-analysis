import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLES_DIR, MODEL_ID, PROMPT_VERSION, LLM_TOTAL_CHAR_BUDGET } from "../config.ts";
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
  type Insight,
  type PortfolioJson,
  type TimelineEntry,
  attachTranscriptAnchors,
  buildInsightsFromCommitments,
  normalizeStatus,
  parseCommitmentsFromMarkdown,
  parseRedFlagsFromMarkdown,
  scoreFromCommitments,
} from "./score.ts";

export type TranscriptPayload = {
  callDate: string;
  fyQuarter: string;
  sourceUrl: string;
  text: string;
  charCount: number;
};

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
  /** Attached at read time for deep-linking (not always persisted). */
  transcripts?: TranscriptPayload[];
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
  const portfolioJson = JSON.parse(row.portfolioJson) as PortfolioJson;
  if (!portfolioJson.insights) portfolioJson.insights = [];
  return {
    ...row,
    portfolioJson,
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

function normalizeCommitments(raw: unknown[]): Commitment[] {
  const out: Commitment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const status = normalizeStatus(String(o.status ?? ""));
    if (!status) continue;
    const evidence = String(o.evidence ?? "");
    out.push({
      quarter: String(o.quarter ?? ""),
      commitment: String(o.commitment ?? ""),
      status,
      evidence,
      quote: String(o.quote ?? evidence),
    });
  }
  return out;
}

function normalizeInsights(raw: unknown[]): Insight[] {
  const out: Insight[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kindRaw = String(o.kind ?? "guidance").toLowerCase();
    const kind = (
      ["delivered", "missed", "open", "risk", "guidance"].includes(kindRaw)
        ? kindRaw
        : "guidance"
    ) as Insight["kind"];
    out.push({
      id: String(o.id ?? `i-${i}`),
      kind,
      title: String(o.title ?? ""),
      body: String(o.body ?? o.title ?? ""),
      quarter: String(o.quarter ?? ""),
      quote: String(o.quote ?? o.body ?? ""),
    });
  }
  return out.filter((x) => x.title || x.quote);
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
  // Persist enriched insights back so next Show is faster / more complete
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

function extractJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON object in model response");
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

function packTranscriptsForLlm(
  blocks: Array<{ fyQuarter: string; callDate: string; text: string }>
): Array<{ fyQuarter: string; callDate: string; text: string }> {
  let remaining = LLM_TOTAL_CHAR_BUDGET;
  const out: Array<{ fyQuarter: string; callDate: string; text: string }> = [];
  for (const b of blocks) {
    if (remaining < 4_000) break;
    if (b.text.length <= remaining) {
      out.push(b);
      remaining -= b.text.length;
    } else {
      out.push({
        ...b,
        text:
          b.text.slice(0, remaining) +
          "\n\n[... truncated for LLM context only — full transcript kept in UI ...]",
      });
      remaining = 0;
    }
  }
  return out;
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

  // Reparse happens automatically for any row still marked truncated (old 15k bug).
  // Pass --force / ?force=1 to re-download+reparse everything.
  const ingest = await ingestSymbol(sym, undefined, { forceReparse: Boolean(opts.force) });
  const transcripts = loadParsedTranscripts(sym);
  const latestUrl = transcripts[0]?.sourceUrl ?? ingest.latestSourceUrl;

  if (!transcripts.length) {
    if (cached) {
      console.log(`[analyze] no transcripts; returning prior cache for ${sym}`);
      return withTranscripts({ ...cached, cacheHit: true, updateAvailable: false });
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
    return withTranscripts({
      ...cached,
      cacheHit: true,
      updateAvailable: false,
      source: "db",
    });
  }

  const needsLlm = true;
  if (needsLlm && !process.env.OPENROUTER_API_KEY) {
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
      "No saved analysis yet. Set OPENROUTER_API_KEY in .env to run the first analysis (then it is cached until a new concall)."
    );
  }

  console.log(
    `[analyze] cache miss ${sym} — running LLM model=${MODEL_ID} (force=${Boolean(opts.force)} priorUrl=${cached?.latestSourceUrl ?? "none"} newUrl=${latestUrl})`
  );

  // Pack newest-first into a total char budget. UI still has full texts in DB.
  const packed = packTranscriptsForLlm(
    transcripts.map((t) => ({
      fyQuarter: t.fyQuarter,
      callDate: t.callDate,
      text: t.text,
    }))
  );
  console.log(
    `[analyze] LLM pack: ${packed.map((p) => `${p.fyQuarter}:${p.text.length}`).join(", ")} (budget=${LLM_TOTAL_CHAR_BUDGET})`
  );

  const { markdown, extracted } = await runLlmHealthcheck(sym, packed);

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

  let insights = normalizeInsights(
    Array.isArray(extracted.insights) ? (extracted.insights as unknown[]) : []
  );
  if (insights.length < 4) {
    insights = buildInsightsFromCommitments(commitments, redFlags);
  }

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

  let portfolioJson: PortfolioJson = {
    symbol: sym,
    healthScore,
    label,
    rawScore,
    redFlags,
    commitments,
    insights,
    timeline,
    summary: String(extracted.summary ?? "").trim(),
    transcriptCount: transcripts.length,
    latestSourceUrl: latestUrl,
    scoredAt: nowIso(),
  };
  portfolioJson = attachTranscriptAnchors(portfolioJson, transcripts);

  const createdAt = cached?.createdAt ?? nowIso();
  const record: Omit<AnalysisRecord, "cacheHit" | "source" | "updateAvailable" | "transcripts"> = {
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
    `[analyze] saved ${sym} score=${healthScore} (${label}) commitments=${commitments.length} insights=${insights.length}`
  );
  return withTranscripts({
    ...record,
    cacheHit: false,
    source: "fresh",
    updateAvailable: false,
  });
}

/**
 * Read-only. Never calls the LLM.
 * Order: SQLite → bundled examples/{SYMBOL}.json (seeded into DB on hit).
 * Always attaches transcript texts + quote char offsets when PDFs are parsed locally.
 */
export function getAnalysis(symbol: string): AnalysisRecord | null {
  const sym = symbol.trim().toUpperCase();
  let cached = getCached(sym);
  if (!cached) {
    const example = loadExample(sym);
    if (!example) return null;
    saveAnalysis(example);
    console.log(`[analyze] seeded DB from examples/${sym}.json (get)`);
    cached = { ...getCached(sym)!, source: "example", cacheHit: true };
  }
  return withTranscripts(cached);
}
