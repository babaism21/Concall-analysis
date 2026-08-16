import { ANALYZE_CONCURRENCY, MODEL_ID, PROMPT_VERSION, TRANSCRIPT_CHAR_CAP } from "../config.ts";
import { getLlmClient } from "../llm.ts";
import type { Commitment, Insight, TimelineEntry } from "./score.ts";
import { normalizeStatus } from "./score.ts";
import {
  PER_CALL_SYSTEM,
  SYNTHESIS_SYSTEM,
  buildPerCallPrompt,
  buildSynthesisPrompt,
  type PerCallSummaryInput,
} from "./prompts.ts";
import { getCachedExtract, saveCallExtract, sha256Text } from "../db/extractCache.ts";

export type TranscriptBlock = {
  fyQuarter: string;
  callDate: string;
  sourceUrl: string;
  text: string;
};

export type PerCallExtract = {
  fyQuarter: string;
  callDate: string;
  sourceUrl: string;
  callScore: number;
  summary: string;
  insights: Insight[];
  guidance: Array<{ title: string; body: string }>;
  negative: Array<{ title: string; body: string }>;
};

export type SynthesisResult = {
  summary: string;
  rawScore: number | null;
  redFlags: string[];
  commitments: Commitment[];
  timeline: TimelineEntry[];
  markdown: string;
};

function extractJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON object in model response");
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    let frag = cleaned.slice(start);
    frag = frag.replace(/,\s*$/, "");
    frag = frag.replace(/,?\s*"[^"]*$/, "");
    const opens = (frag.match(/\[/g) ?? []).length - (frag.match(/\]/g) ?? []).length;
    const openo = (frag.match(/\{/g) ?? []).length - (frag.match(/\}/g) ?? []).length;
    frag += "]".repeat(Math.max(0, opens)) + "}".repeat(Math.max(0, openo));
    return JSON.parse(frag) as Record<string, unknown>;
  }
}

function parsePerCallJson(raw: string): Record<string, unknown> {
  try {
    return extractJsonObject(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`JSON parse failed: ${msg}`);
  }
}

function emptyPerCallExtract(call: TranscriptBlock, reason: string): PerCallExtract {
  console.warn(`[analyze] per-call fallback ${call.fyQuarter} ${call.callDate}: ${reason}`);
  return {
    fyQuarter: call.fyQuarter,
    callDate: call.callDate,
    sourceUrl: call.sourceUrl,
    callScore: 5,
    summary: `${call.fyQuarter} concall — automated extract unavailable`,
    insights: [],
    guidance: [],
    negative: [],
  };
}

function trimTextForLlm(text: string): string {
  if (text.length <= TRANSCRIPT_CHAR_CAP) return text;
  return (
    text.slice(0, TRANSCRIPT_CHAR_CAP) +
    "\n\n[... truncated for LLM context only — full transcript kept in UI ...]"
  );
}

function bulletItems(raw: unknown): Array<{ title: string; body: string; quote: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ title: string; body: string; quote: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = String(o.title ?? "").trim();
    const body = String(o.body ?? title).trim();
    const quote = String(o.quote ?? body).trim();
    if (!title && !quote) continue;
    out.push({ title: title || body.slice(0, 80), body, quote });
  }
  return out;
}

function insightsFromBullets(
  items: Array<{ title: string; body: string; quote: string }>,
  kind: Insight["kind"],
  call: TranscriptBlock,
  idPrefix: string
): Insight[] {
  return items.map((item, i) => ({
    id: `${idPrefix}-${call.callDate}-${i}`,
    kind,
    title: item.title,
    body: item.body,
    quarter: call.fyQuarter,
    quote: item.quote,
    callDate: call.callDate,
    sourceUrl: call.sourceUrl,
  }));
}

export async function analyzeOneTranscript(
  symbol: string,
  call: TranscriptBlock
): Promise<PerCallExtract> {
  const client = getLlmClient();
  const text = trimTextForLlm(call.text);
  console.log(
    `[analyze] per-call ${symbol} ${call.fyQuarter} ${call.callDate} (${text.length} chars, model=${MODEL_ID})`
  );

  const resp = await client.chat.completions.create({
    model: MODEL_ID,
    temperature: 0.2,
    max_tokens: 8192,
    messages: [
      { role: "system", content: PER_CALL_SYSTEM },
      { role: "user", content: buildPerCallPrompt(symbol, { ...call, text }) },
    ],
  });

  const raw = resp.choices[0]?.message?.content?.trim() ?? "{}";
  const finish = resp.choices[0]?.finish_reason;
  console.log(
    `[analyze] per-call ${call.fyQuarter} tokens in=${resp.usage?.prompt_tokens ?? "?"} out=${resp.usage?.completion_tokens ?? "?"} finish=${finish}`
  );

  let data: Record<string, unknown>;
  try {
    data = parsePerCallJson(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (finish === "length") {
      console.log(`[analyze] per-call retry ${call.fyQuarter} (compact)`);
      const retry = await client.chat.completions.create({
        model: MODEL_ID,
        temperature: 0,
        max_tokens: 4096,
        messages: [
          { role: "system", content: PER_CALL_SYSTEM },
          {
            role: "user",
            content: `${buildPerCallPrompt(symbol, { ...call, text })}\n\nIMPORTANT: Previous response truncated. Return MINIMAL JSON: exactly 3 positive, 3 negative, 0 guidance, 0 risks, short fields only.`,
          },
        ],
      });
      try {
        data = parsePerCallJson(retry.choices[0]?.message?.content?.trim() ?? "{}");
      } catch {
        return emptyPerCallExtract(call, msg);
      }
    } else {
      return emptyPerCallExtract(call, msg);
    }
  }
  const positive = bulletItems(data.positive);
  const negative = bulletItems(data.negative);
  const guidance = bulletItems(data.guidance);
  const risks = bulletItems(data.risks);
  const callScore = Number(data.callScore ?? 0);

  const insights: Insight[] = [
    ...insightsFromBullets(positive, "positive", call, "pos"),
    ...insightsFromBullets(negative, "negative", call, "neg"),
    ...insightsFromBullets(guidance, "guidance", call, "gui"),
    ...insightsFromBullets(risks, "risk", call, "rsk"),
  ];

  return {
    fyQuarter: call.fyQuarter,
    callDate: call.callDate,
    sourceUrl: call.sourceUrl,
    callScore: Number.isFinite(callScore) ? callScore : 5,
    summary: String(data.summary ?? "").trim(),
    insights,
    guidance: guidance.map((g) => ({ title: g.title, body: g.body })),
    negative: negative.map((n) => ({ title: n.title, body: n.body })),
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export async function runCrossQuarterSynthesis(
  symbol: string,
  perCalls: PerCallExtract[]
): Promise<SynthesisResult> {
  const client = getLlmClient();
  const inputs: PerCallSummaryInput[] = perCalls.map((c) => ({
    fyQuarter: c.fyQuarter,
    callDate: c.callDate,
    summary: c.summary,
    callScore: c.callScore,
    guidance: c.guidance,
    negative: c.negative,
  }));

  console.log(`[analyze] synthesis ${symbol} (${inputs.length} calls, model=${MODEL_ID})`);

  const resp = await client.chat.completions.create({
    model: MODEL_ID,
    temperature: 0.2,
    max_tokens: 8192,
    messages: [
      { role: "system", content: SYNTHESIS_SYSTEM },
      { role: "user", content: buildSynthesisPrompt(symbol, inputs) },
    ],
  });

  const raw = resp.choices[0]?.message?.content?.trim() ?? "{}";
  console.log(
    `[analyze] synthesis tokens in=${resp.usage?.prompt_tokens ?? "?"} out=${resp.usage?.completion_tokens ?? "?"} finish=${resp.choices[0]?.finish_reason}`
  );

  let data: Record<string, unknown> = {};
  try {
    data = extractJsonObject(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[analyze] synthesis JSON parse failed: ${msg}`);
  }

  const commitments: Commitment[] = [];
  if (Array.isArray(data.commitments)) {
    for (const item of data.commitments as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const status = normalizeStatus(String(o.status ?? ""));
      if (!status) continue;
      commitments.push({
        quarter: String(o.quarter ?? ""),
        commitment: String(o.commitment ?? ""),
        status,
        evidence: String(o.evidence ?? ""),
        quote: String(o.quote ?? o.evidence ?? ""),
      });
    }
  }

  const timeline: TimelineEntry[] = Array.isArray(data.timeline)
    ? (data.timeline as unknown[])
        .map((t) => {
          const o = t as Record<string, unknown>;
          return {
            quarter: String(o.quarter ?? ""),
            score: Number(o.score ?? 0),
            note: String(o.note ?? ""),
          } satisfies TimelineEntry;
        })
        .filter((t) => t.quarter)
    : perCalls.map((c) => ({
        quarter: c.fyQuarter,
        score: c.callScore,
        note: c.summary.slice(0, 120),
      }));

  const summary = String(data.summary ?? "").trim();
  const rawScore =
    typeof data.rawScore === "number"
      ? data.rawScore
      : perCalls.length
        ? Math.round(
            (perCalls.reduce((a, c) => a + c.callScore, 0) / perCalls.length) * 10
          ) / 10
        : null;

  const redFlags = Array.isArray(data.redFlags)
    ? (data.redFlags as unknown[]).map(String).filter(Boolean)
    : [];

  const markdown = [
    `# ${symbol} — Management Health (${PROMPT_VERSION})`,
    "",
    "## Management Health Summary",
    summary || perCalls.map((c) => `**${c.fyQuarter}:** ${c.summary}`).join("\n\n"),
    "",
    "## Per-call coverage",
    ...perCalls.map(
      (c) =>
        `- **${c.fyQuarter}** (${c.callDate}): ${c.insights.length} cards, callScore ${c.callScore}`
    ),
    "",
    "## Red Flags",
    redFlags.length ? redFlags.map((r) => `- ${r}`).join("\n") : "None material",
  ].join("\n");

  return { summary, rawScore, redFlags, commitments, timeline, markdown };
}

/**
 * Hash-cached + parallel per-transcript extracts, then one synthesis.
 * force=true bypasses extract cache and re-LLMs every call.
 */
export async function analyzeAllTranscripts(
  symbol: string,
  transcripts: TranscriptBlock[],
  opts: { force?: boolean } = {}
): Promise<{
  perCalls: PerCallExtract[];
  synthesis: SynthesisResult;
  allInsights: Insight[];
  llmCalls: number;
  cacheHits: number;
}> {
  let llmCalls = 0;
  let cacheHits = 0;

  const perCalls = await mapPool(transcripts, ANALYZE_CONCURRENCY, async (t) => {
    const hash = sha256Text(t.text);
    if (!opts.force) {
      const cached = getCachedExtract(hash);
      if (cached) {
        cacheHits++;
        console.log(`[analyze] extract cache hit ${t.fyQuarter} ${t.callDate}`);
        return {
          ...cached,
          fyQuarter: t.fyQuarter,
          callDate: t.callDate,
          sourceUrl: t.sourceUrl,
        };
      }
    }

    const extract = await analyzeOneTranscript(symbol, t);
    llmCalls++;
    saveCallExtract({
      textSha256: hash,
      symbol,
      callDate: t.callDate,
      fyQuarter: t.fyQuarter,
      sourceUrl: t.sourceUrl,
      extract,
    });
    return extract;
  });

  const synthesis = await runCrossQuarterSynthesis(symbol, perCalls);

  const commitmentInsights: Insight[] = synthesis.commitments.map((c, i) => {
    const kind =
      c.status === "Met" || c.status === "Partially Completed"
        ? "delivered"
        : c.status === "Not Met"
          ? "missed"
          : "open";
    return {
      id: `x-${i}`,
      kind,
      title: c.commitment,
      body: c.evidence,
      quarter: c.quarter,
      status: c.status,
      quote: c.quote || c.evidence,
    };
  });

  const allInsights = [...perCalls.flatMap((c) => c.insights), ...commitmentInsights];

  synthesis.redFlags.forEach((flag, i) => {
    allInsights.push({
      id: `rf-${i}`,
      kind: "risk",
      title: flag.slice(0, 100),
      body: flag,
      quarter: "",
      quote: flag.slice(0, 180),
    });
  });

  console.log(
    `[analyze] ${symbol} extracts: llm=${llmCalls} cacheHits=${cacheHits} concurrency=${ANALYZE_CONCURRENCY}`
  );

  return { perCalls, synthesis, allInsights, llmCalls, cacheHits };
}
