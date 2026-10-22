/**
 * Prompts for the three model steps. The model extracts and judges; it never
 * computes numbers. All figures come from metrics.ts.
 */
import type { MetricKey } from "./types.ts";

export const METRIC_CATALOGUE: Record<MetricKey, string> = {
  revenue_yoy_latest_q: "revenue growth vs same quarter last year, % (quarterly series available)",
  op_profit_yoy_latest_q: "operating profit (before other income) growth YoY, % (quarterly series)",
  core_margin_latest_q: "operating margin excluding other income, latest quarter, % (quarterly series)",
  core_margin_year_ago_q: "operating margin excluding other income, same quarter last year, %",
  core_margin_trailing_avg: "operating margin excluding other income, last 4 quarters, %",
  pat_yoy_latest_q: "net profit growth YoY, % (quarterly series)",
  other_income_share_of_pbt_ttm: "other income as % of pre-tax profit, trailing 12 months",
  revenue_cagr_3y: "revenue compound annual growth over the last 3 fiscal years, %",
  pat_cagr_3y: "net profit compound annual growth over the last 3 fiscal years, %",
  cfo_to_pat_latest_fy: "operating cash flow as % of net profit, latest fiscal year",
  debtor_days_latest_fy: "debtor days, latest fiscal year",
  debtor_days_change_1y: "change in debtor days vs prior year",
  pe_trailing: "price / trailing earnings, x",
  pe_forward_1: "price / next fiscal year consensus EPS, x",
  pe_forward_2: "price / fiscal year after next consensus EPS, x",
  net_cash_pct_mcap: "(cash − borrowings) as % of market cap",
  promoter_holding_pct: "promoter shareholding, %",
  promoter_holding_change_2y: "change in promoter holding over 2 years, percentage points",
  promoter_pledge_pct: "share of promoter holding pledged, %",
  one_off_share_of_pbt_latest_q: "disclosed one-offs as % of pre-tax profit, latest quarter",
};

const catalogueText = Object.entries(METRIC_CATALOGUE)
  .map(([k, d]) => `  ${k}: ${d}`)
  .join("\n");

/* ------------------------------------------------------------------ */
/* Step 1 — split thesis into claims; parse "I'm wrong if" lines        */
/* ------------------------------------------------------------------ */

export const EXTRACT_SYSTEM = `You split an Indian retail investor's stock thesis into atomic, checkable claims.
Rules:
- One idea per claim. Keep the investor's meaning; don't add claims they didn't make.
- type: growth | margin | moat | management | valuation | tailwind | catalyst | balance_sheet | other
- importance: "core" if it is a main reason to buy, else "supporting". Usually 1–3 core claims.
- isMacro: true if the claim is about the economy, a sector or a trend in general (e.g. "water demand will rise"), false if it is about this company.
- check: ONLY when the claim states or clearly implies a number that one metric below can test. Otherwise null.
  Vague words ("reasonable", "visible", "huge") are NOT numbers — use null.
- For "I'm wrong if…" conditions, map each to a rule when one metric can test it, else rule = null.
  consecutivePeriods: N when the condition says "N quarters in a row", else 1.
Available metrics:
${catalogueText}
Return ONLY JSON.`;

export function buildExtractPrompt(symbol: string, thesis: string, wrongIf: string[]): string {
  return `Stock: ${symbol}

Thesis:
"""
${thesis}
"""

"I'm wrong if" conditions written by the investor:
${wrongIf.length ? wrongIf.map((w, i) => `${i + 1}. ${w}`).join("\n") : "(none)"}

Return JSON:
{
  "claims": [
    { "text": "...", "type": "growth", "importance": "core", "isMacro": false,
      "check": { "metric": "revenue_cagr_3y", "op": ">=", "threshold": 20 } }
  ],
  "triggers": [
    { "text": "<the investor's condition, verbatim>",
      "rule": { "metric": "core_margin_latest_q", "op": "<", "threshold": 11, "consecutivePeriods": 2 } }
  ]
}`;
}

/* ------------------------------------------------------------------ */
/* Step 2 — judge claims that rules couldn't decide                     */
/* ------------------------------------------------------------------ */

export const JUDGE_SYSTEM = `You are a sceptical equity analyst testing an investor's claims about an Indian listed company.
You get pre-computed metrics, business-mix facts and management concall findings. Judge each claim ONLY from that evidence.
Verdicts:
- Supported: the evidence clearly backs the claim.
- Weak: some support, but the evidence is thin, small in size, or only partly matches.
- Contradicted: the evidence points the other way.
- Unverifiable: the evidence given can't confirm or deny it (typical for macro trends and vague words).
- Pending: depends on a future event that hasn't happened yet.
Hard rules:
- NEVER invent or compute numbers. Every number you write must appear in the evidence given.
- For a macro claim, ask whether the trend shows up in THIS company's numbers; if the company's exposure is small, say so and use Weak.
- For vague claims ("valuation is reasonable"), judge against the metrics, and say what benchmark is missing.
- Cite evidence as metric keys, segment keys, or concall items (quote ≤ 20 words).
Return ONLY JSON.`;

export function buildJudgePrompt(
  symbol: string,
  thesis: string,
  claims: Array<{ id: string; text: string; type: string; isMacro: boolean }>,
  metricsBlock: string,
  concallBlock: string
): string {
  return `Stock: ${symbol}
Full thesis (for context): """${thesis}"""

METRICS AND FACTS:
${metricsBlock || "(none)"}

MANAGEMENT CONCALL FINDINGS:
${concallBlock || "(none available)"}

CLAIMS TO JUDGE:
${claims.map((c) => `- ${c.id} [${c.type}${c.isMacro ? ", macro" : ""}]: ${c.text}`).join("\n")}

Return JSON:
{ "results": [
  { "id": "c1", "verdict": "Weak", "confidence": "medium",
    "reason": "one or two plain sentences",
    "evidence": [ { "kind": "metric", "ref": "revenue_yoy_latest_q", "text": "..." },
                  { "kind": "segment", "ref": "industrial_orderbook_pct", "text": "..." },
                  { "kind": "concall", "ref": "Q1 FY27", "text": "...", "quote": "..." } ] }
] }`;
}

/* ------------------------------------------------------------------ */
/* Step 3 — coaching                                                    */
/* ------------------------------------------------------------------ */

export const COACH_SYSTEM = `You coach an experienced Indian DIY investor to sharpen their stock thesis, Socratic style.
- Ask at most 3 pointed questions that expose the biggest gap between what they believe and what the evidence shows.
- Suggest a one or two sentence rewrite of the thesis built on what the evidence actually supports. Use no numbers that aren't in the input.
- If they wrote no "I'm wrong if" conditions, suggest 3 that are concrete and checkable, using the metric keys given.
- Never tell them to buy or sell. Plain English, no jargon.
Return ONLY JSON.`;

export function buildCoachPrompt(
  symbol: string,
  thesis: string,
  claimSummary: string,
  blindSpotSummary: string,
  hasTriggers: boolean
): string {
  return `Stock: ${symbol}
Thesis: """${thesis}"""

CLAIM VERDICTS:
${claimSummary}

BLIND SPOTS FOUND BY RULES:
${blindSpotSummary || "(none)"}

The investor ${hasTriggers ? "DID" : "did NOT"} write "I'm wrong if" conditions.
Available metric keys for suggested conditions:
${catalogueText}

Return JSON:
{ "questions": ["...", "..."],
  "rewrite": "...",
  "suggestedTriggers": [ { "text": "Operating margin stays below 11% for 2 quarters in a row",
                           "rule": { "metric": "core_margin_latest_q", "op": "<", "threshold": 11, "consecutivePeriods": 2 } } ] }`;
}
