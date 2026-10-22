/**
 * Thesis engine: a pipeline, not one big prompt.
 *
 *   thesis text
 *     → 1. extract claims + parse "I'm wrong if" (cheap model)
 *     → 2. compute metrics (code) and load concall findings (existing module, read-only)
 *     → 3. verdicts: rules first for numeric claims, model for the rest (strong model)
 *     → 4. blind spots (code) + invalidation trigger check (code)
 *     → 5. coaching questions + rewrite + suggested triggers (strong model)
 *     → 6. headline (code) → ThesisCard
 */
import { MODEL_ID } from "../config.ts";
import { getLlmClient } from "../llm.ts";
import { getAnalysis } from "../analyze/run.ts";
import { computeMetrics, metricsForPrompt } from "./metrics.ts";
import { METRIC_CATALOGUE, EXTRACT_SYSTEM, JUDGE_SYSTEM, COACH_SYSTEM, buildExtractPrompt, buildJudgePrompt, buildCoachPrompt } from "./prompts.ts";
import { checkTriggers, countVerdicts, findBlindSpots, headline, verdictByRule } from "./rules.ts";
import type {
  Claim,
  ClaimImportance,
  ClaimResult,
  ClaimType,
  ConcallContext,
  Evidence,
  Fundamentals,
  InvalidationTrigger,
  MetricKey,
  ThesisCard,
  TriggerOp,
  Verdict,
} from "./types.ts";

export const ENGINE_VERSION = "thesis-v0.1";
export const DISCLAIMER =
  "Analysis to test your own reasoning, not investment advice or a buy/sell recommendation.";

export const EXTRACT_MODEL = process.env.THESIS_EXTRACT_MODEL ?? MODEL_ID;
export const JUDGE_MODEL = process.env.THESIS_JUDGE_MODEL ?? MODEL_ID;

/** Swappable model call, so tests can run without a network. */
export type LlmCall = (system: string, user: string, model: string) => Promise<string>;

export const openRouterCall: LlmCall = async (system, user, model) => {
  const res = await getLlmClient().chat.completions.create({
    model,
    temperature: 0.1,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
};

/* ------------------------------------------------------------------ */
/* Parsing helpers — the model's output is untrusted input              */
/* ------------------------------------------------------------------ */

export function parseJson(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Model returned no JSON object");
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

const CLAIM_TYPES: ClaimType[] = ["growth", "margin", "moat", "management", "valuation", "tailwind", "catalyst", "balance_sheet", "other"];
const VERDICTS: Verdict[] = ["Supported", "Weak", "Contradicted", "Unverifiable", "Pending"];
const OPS: TriggerOp[] = ["<", "<=", ">", ">="];
const isMetric = (k: unknown): k is MetricKey => typeof k === "string" && k in METRIC_CATALOGUE;

function parseCheck(raw: unknown): Claim["check"] {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!isMetric(o.metric) || !OPS.includes(o.op as TriggerOp) || typeof o.threshold !== "number") return null;
  return { metric: o.metric, op: o.op as TriggerOp, threshold: o.threshold };
}

function parseTrigger(raw: unknown, id: string): InvalidationTrigger | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const text = String(o.text ?? "").trim();
  if (!text) return null;
  const check = parseCheck(o.rule);
  const r = (o.rule ?? {}) as Record<string, unknown>;
  const n = Number(r.consecutivePeriods ?? 1);
  return { id, text, rule: check ? { ...check, consecutivePeriods: Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1 } : null };
}

export function parseExtraction(raw: Record<string, unknown>, wrongIf: string[]): { claims: Claim[]; triggers: InvalidationTrigger[] } {
  const claims: Claim[] = [];
  for (const [i, c] of (Array.isArray(raw.claims) ? raw.claims : []).entries()) {
    const o = (c ?? {}) as Record<string, unknown>;
    const text = String(o.text ?? "").trim();
    if (!text) continue;
    claims.push({
      id: `c${i + 1}`,
      text,
      type: CLAIM_TYPES.includes(o.type as ClaimType) ? (o.type as ClaimType) : "other",
      importance: (o.importance === "core" ? "core" : "supporting") as ClaimImportance,
      isMacro: o.isMacro === true,
      check: parseCheck(o.check),
    });
  }
  const parsed = (Array.isArray(raw.triggers) ? raw.triggers : [])
    .map((t, i) => parseTrigger(t, `t${i + 1}`))
    .filter((t): t is InvalidationTrigger => !!t);
  // The investor's own words always survive, even if the model dropped one.
  const triggers = wrongIf.map((text, i) => {
    const match = parsed.find((p) => p.text.toLowerCase() === text.toLowerCase()) ?? parsed[i];
    return { id: `t${i + 1}`, text, rule: match?.rule ?? null };
  });
  return { claims, triggers };
}

/**
 * Guardrail: every number in a model-written sentence must exist in the
 * evidence we gave it. Returns the numbers that don't.
 */
export function inventedNumbers(sentence: string, context: string): string[] {
  const norm = (s: string) => s.replace(/,/g, "");
  const ctx = norm(context);
  const nums = norm(sentence).match(/\d+(?:\.\d+)?/g) ?? [];
  return [...new Set(nums)].filter((n) => Number(n) > 10 && !ctx.includes(n));
}

/* ------------------------------------------------------------------ */
/* Concall context from the existing management-health module           */
/* ------------------------------------------------------------------ */

export async function loadConcallContext(symbol: string): Promise<ConcallContext> {
  try {
    const rec = await getAnalysis(symbol); // read-only: cache or bundled example, never runs the LLM
    if (!rec) return { available: false, redFlags: [], commitments: [] };
    const p = rec.portfolioJson;
    return {
      available: true,
      healthScore: p.healthScore,
      label: p.label,
      redFlags: p.redFlags ?? [],
      commitments: (p.commitments ?? []).map((c) => ({
        quarter: c.quarter,
        commitment: c.commitment,
        status: c.status,
        evidence: c.evidence,
      })),
      latestSourceUrl: p.latestSourceUrl,
    };
  } catch (err) {
    console.warn(`[thesis] concall context unavailable: ${err instanceof Error ? err.message : err}`);
    return { available: false, redFlags: [], commitments: [] };
  }
}

function concallForPrompt(c: ConcallContext): string {
  if (!c.available) return "";
  const lines = [`Management delivery score: ${c.healthScore}/100 (${c.label}), from past concall commitments.`];
  for (const f of c.redFlags.slice(0, 8)) lines.push(`- Red flag: ${f}`);
  for (const m of c.commitments.slice(0, 15)) lines.push(`- ${m.quarter} commitment "${m.commitment}" → ${m.status}. ${m.evidence}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* The pipeline                                                         */
/* ------------------------------------------------------------------ */

export type TestThesisInput = {
  symbol: string;
  thesis: string;
  wrongIf?: string[];
  fundamentals: Fundamentals;
  concall?: ConcallContext;
  llm?: LlmCall;
};

export async function testThesis(input: TestThesisInput): Promise<ThesisCard> {
  const llm = input.llm ?? openRouterCall;
  const symbol = input.symbol.toUpperCase();
  const wrongIf = (input.wrongIf ?? []).map((w) => w.trim()).filter(Boolean);
  const f = input.fundamentals;

  // 1. Claims
  const extraction = parseExtraction(
    parseJson(await llm(EXTRACT_SYSTEM, buildExtractPrompt(symbol, input.thesis, wrongIf), EXTRACT_MODEL)),
    wrongIf
  );
  const { claims, triggers } = extraction;

  // 2. Evidence
  const { metrics, series } = computeMetrics(f);
  const concall = input.concall ?? (await loadConcallContext(symbol));
  const metricsBlock = metricsForPrompt(metrics, f);
  const concallBlock = concallForPrompt(concall);
  const context = `${metricsBlock}\n${concallBlock}\n${input.thesis}`;

  // 3. Verdicts — rules first
  const results = new Map<string, ClaimResult>();
  for (const c of claims) {
    const byRule = verdictByRule(c, metrics);
    if (byRule) results.set(c.id, byRule);
  }
  const forModel = claims.filter((c) => !results.has(c.id));
  if (forModel.length) {
    const raw = parseJson(
      await llm(
        JUDGE_SYSTEM,
        buildJudgePrompt(symbol, input.thesis, forModel.map(({ id, text, type, isMacro }) => ({ id, text, type, isMacro })), metricsBlock, concallBlock),
        JUDGE_MODEL
      )
    );
    const judged = new Map<string, Record<string, unknown>>();
    for (const r of Array.isArray(raw.results) ? raw.results : []) {
      const o = (r ?? {}) as Record<string, unknown>;
      if (typeof o.id === "string") judged.set(o.id, o);
    }
    for (const c of forModel) {
      const o = judged.get(c.id);
      let verdict: Verdict = VERDICTS.includes(o?.verdict as Verdict) ? (o!.verdict as Verdict) : "Unverifiable";
      let confidence = (["high", "medium", "low"].includes(o?.confidence as string) ? o!.confidence : "low") as ClaimResult["confidence"];
      let reason = String(o?.reason ?? "The model returned no judgement for this claim.").trim();
      const evidence: Evidence[] = [];
      for (const e of Array.isArray(o?.evidence) ? o!.evidence : []) {
        const x = (e ?? {}) as Record<string, unknown>;
        const text = String(x.text ?? "").trim();
        if (!text) continue;
        if (x.kind === "metric" && isMetric(x.ref) && metrics[x.ref]) {
          evidence.push({ text, source: { kind: "metric", metric: x.ref } });
        } else if (x.kind === "segment") {
          evidence.push({ text, source: { kind: "fundamentals", field: String(x.ref ?? "") } });
        } else if (x.kind === "concall" && concall.available) {
          evidence.push({ text, source: { kind: "concall", quarter: String(x.ref ?? ""), quote: x.quote ? String(x.quote) : undefined, sourceUrl: concall.latestSourceUrl ?? undefined } });
        }
        // anything else is dropped: evidence must point at something we actually supplied
      }
      const bad = inventedNumbers(`${reason} ${evidence.map((e) => e.text).join(" ")}`, context);
      if (bad.length) {
        confidence = "low";
        reason += ` (Figures ${bad.join(", ")} don't match the source data. Treat this verdict with caution.)`;
      }
      if (verdict === "Supported" && !evidence.length) {
        verdict = "Weak";
        reason += " (No evidence was cited, so this was downgraded from Supported.)";
      }
      results.set(c.id, { ...c, verdict, verdictBy: "model", confidence, reason, evidence });
    }
  }
  const claimResults = claims.map((c) => results.get(c.id)!);

  // 4. Blind spots + triggers
  const blindSpots = findBlindSpots(metrics, claims);
  const triggerStatus = checkTriggers(triggers, metrics, series);

  // 5. Coaching
  let coachingQuestions: string[] = [];
  let suggestedRewrite: string | null = null;
  let suggestedTriggers: InvalidationTrigger[] = [];
  try {
    const raw = parseJson(
      await llm(
        COACH_SYSTEM,
        buildCoachPrompt(
          symbol,
          input.thesis,
          claimResults.map((c) => `- [${c.verdict}] (${c.importance}${c.isMacro ? ", macro" : ""}) ${c.text}: ${c.reason}`).join("\n"),
          blindSpots.map((b) => `- [${b.severity}] ${b.title}: ${b.detail}`).join("\n"),
          triggers.length > 0
        ),
        JUDGE_MODEL
      )
    );
    coachingQuestions = (Array.isArray(raw.questions) ? raw.questions : []).map(String).filter(Boolean).slice(0, 3);
    suggestedRewrite = typeof raw.rewrite === "string" && raw.rewrite.trim() ? raw.rewrite.trim() : null;
    if (!triggers.length) {
      suggestedTriggers = (Array.isArray(raw.suggestedTriggers) ? raw.suggestedTriggers : [])
        .map((t, i) => parseTrigger(t, `s${i + 1}`))
        .filter((t): t is InvalidationTrigger => !!t)
        .slice(0, 4);
    }
    if (suggestedRewrite && inventedNumbers(suggestedRewrite, context).length) {
      suggestedRewrite = null; // a rewrite with made-up figures is worse than none
    }
  } catch (err) {
    console.warn(`[thesis] coaching step failed: ${err instanceof Error ? err.message : err}`);
  }

  // 6. Headline
  const h = headline(claimResults, blindSpots, triggerStatus);
  return {
    symbol,
    thesisText: input.thesis,
    headline: h.headline,
    headlineReason: h.reason,
    counts: countVerdicts(claimResults),
    claims: claimResults,
    blindSpots,
    coachingQuestions,
    suggestedRewrite,
    triggers,
    triggerStatus,
    suggestedTriggers,
    metrics,
    dataAsOf: f.asOf ?? null,
    modelId: JUDGE_MODEL,
    engineVersion: ENGINE_VERSION,
    createdAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
  };
}

/**
 * Monitoring re-check: no model calls. Re-runs rule-based claim checks,
 * blind spots and triggers against fresh fundamentals; model-judged claims
 * keep their previous verdict until the next full re-test.
 */
export function recheckCard(prev: ThesisCard, fresh: Fundamentals): { card: ThesisCard; changes: string[] } {
  const { metrics, series } = computeMetrics(fresh);
  const changes: string[] = [];
  const claims = prev.claims.map((c) => {
    if (c.verdictBy !== "rule") return c;
    const next = verdictByRule(c, metrics);
    if (!next) return c;
    if (next.verdict !== c.verdict) changes.push(`Claim "${c.text}": ${c.verdict} → ${next.verdict}. ${next.reason}`);
    return next;
  });
  const blindSpots = findBlindSpots(metrics, claims);
  const prevSpots = new Set(prev.blindSpots.map((b) => b.id));
  for (const b of blindSpots) if (!prevSpots.has(b.id)) changes.push(`New blind spot: ${b.title}. ${b.detail}`);
  const triggerStatus = checkTriggers(prev.triggers, metrics, series);
  for (const t of triggerStatus) {
    const before = prev.triggerStatus.find((p) => p.triggerId === t.triggerId);
    if (t.status === "fired" && before?.status !== "fired") changes.push(`🚨 Your "I'm wrong if" condition fired: ${t.text} (${t.detail})`);
  }
  const h = headline(claims, blindSpots, triggerStatus);
  if (h.headline !== prev.headline) changes.push(`Headline: ${prev.headline} → ${h.headline}. ${h.reason}`);
  return {
    card: {
      ...prev,
      headline: h.headline,
      headlineReason: h.reason,
      counts: countVerdicts(claims),
      claims,
      blindSpots,
      triggerStatus,
      metrics,
      dataAsOf: fresh.asOf ?? null,
      createdAt: new Date().toISOString(),
    },
    changes,
  };
}
