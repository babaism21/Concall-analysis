/**
 * Offline tests — no API key or network needed. The model is replaced by a
 * scripted fake so the pipeline, rules and guardrails can be checked exactly.
 *
 *   npx tsx --test src/thesis/thesis.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { computeMetrics } from "./metrics.ts";
import { findBlindSpots, checkTriggers, verdictByRule } from "./rules.ts";
import { testThesis, recheckCard, inventedNumbers, type LlmCall } from "./engine.ts";
import { EXTRACT_SYSTEM, JUDGE_SYSTEM } from "./prompts.ts";
import { useThesisDb, saveNewThesis, getLatest, addVersion, listTheses } from "./store.ts";
import type { Fundamentals } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const wabag = (): Fundamentals =>
  JSON.parse(readFileSync(join(ROOT, "examples/thesis/WABAG.fundamentals.json"), "utf8"));

const THESIS =
  "Demand for fresh water will rise due to pollution, AI, data centres and semiconductors, and Wabag will benefit hugely. Valuation is reasonable and growth is visible.";

const fakeLlm: LlmCall = async (system) => {
  if (system === EXTRACT_SYSTEM) {
    return JSON.stringify({
      claims: [
        { text: "Demand for fresh water will rise", type: "tailwind", importance: "supporting", isMacro: true, check: null },
        { text: "Pollution will drive demand Wabag captures", type: "tailwind", importance: "supporting", isMacro: false, check: null },
        { text: "AI, data centres and semiconductors will benefit Wabag hugely", type: "tailwind", importance: "core", isMacro: false, check: null },
        { text: "Valuation is reasonable", type: "valuation", importance: "core", isMacro: false, check: null },
        { text: "Growth is visible", type: "growth", importance: "core", isMacro: false, check: null },
        { text: "Revenue grows at least 15% a year", type: "growth", importance: "supporting", isMacro: false,
          check: { metric: "revenue_cagr_3y", op: ">=", threshold: 15 } },
      ],
      triggers: [
        { text: "Operating margin below 11% for 2 quarters in a row",
          rule: { metric: "core_margin_latest_q", op: "<", threshold: 11, consecutivePeriods: 2 } },
      ],
    });
  }
  if (system === JUDGE_SYSTEM) {
    return JSON.stringify({
      results: [
        { id: "c1", verdict: "Unverifiable", confidence: "medium", reason: "A general trend, not testable for one company.", evidence: [] },
        { id: "c2", verdict: "Supported", confidence: "medium", reason: "Municipal is 88% of the order book.",
          evidence: [{ kind: "segment", ref: "municipal_orderbook_pct", text: "Municipal share of order book 88%" }] },
        { id: "c3", verdict: "Weak", confidence: "high", reason: "Industrial is only 12% of the order book.",
          evidence: [{ kind: "segment", ref: "industrial_orderbook_pct", text: "Industrial share 12%" }] },
        // invented number (31.5x) — guardrail must catch it
        { id: "c4", verdict: "Supported", confidence: "high", reason: "Trades at 31.5x, below peers.",
          evidence: [{ kind: "metric", ref: "pe_forward_1", text: "Forward P/E" }] },
        // claims Supported with no evidence — must be downgraded
        { id: "c5", verdict: "Supported", confidence: "high", reason: "Order book is large.", evidence: [] },
      ],
    });
  }
  return JSON.stringify({
    questions: ["If data centres stay a small share of orders, would you still buy?"],
    rewrite: "A municipal water and desalination order book converting into steady growth.",
    suggestedTriggers: [],
  });
};

test("metrics: arithmetic matches the hand-checked WABAG card", () => {
  const { metrics } = computeMetrics(wabag());
  assert.equal(metrics.revenue_yoy_latest_q?.value, 20.8);
  assert.equal(metrics.core_margin_latest_q?.value, 9);
  assert.equal(metrics.core_margin_year_ago_q?.value, 13.1);
  assert.equal(metrics.op_profit_yoy_latest_q?.value, -16.7);
  assert.equal(metrics.pat_yoy_latest_q?.value, 36.4);
  assert.equal(metrics.pe_forward_1?.value, 23.8);
  assert.equal(metrics.pe_forward_2?.value, 19.3);
  assert.equal(metrics.cfo_to_pat_latest_fy?.value, 55.9);
  assert.equal(metrics.other_income_share_of_pbt_ttm?.value, 29.2);
  assert.equal(metrics.one_off_share_of_pbt_latest_q?.value, 31.2);
  assert.equal(metrics.net_cash_pct_mcap?.value, 8.7);
  assert.equal(metrics.revenue_cagr_3y?.value, 10);
});

test("blind spots: catches the margin drop hidden by a forex gain", () => {
  const { metrics } = computeMetrics(wabag());
  const ids = findBlindSpots(metrics, []).map((b) => b.id);
  for (const id of ["core_margin_drop", "profit_outpacing_core", "one_off_profit", "weak_cash_conversion", "slow_collections"]) {
    assert.ok(ids.includes(id), `missing blind spot ${id}`);
  }
  assert.equal(findBlindSpots(metrics, [])[0].severity, "high");
});

test("rule verdicts: pass, close miss, clear miss", () => {
  const { metrics } = computeMetrics(wabag()); // 3y revenue CAGR = 10%
  const base = { id: "x", text: "t", type: "growth" as const, importance: "core" as const, isMacro: false };
  assert.equal(verdictByRule({ ...base, check: { metric: "revenue_cagr_3y", op: ">=", threshold: 8 } }, metrics)?.verdict, "Supported");
  assert.equal(verdictByRule({ ...base, check: { metric: "revenue_cagr_3y", op: ">=", threshold: 12 } }, metrics)?.verdict, "Weak");
  assert.equal(verdictByRule({ ...base, check: { metric: "revenue_cagr_3y", op: ">=", threshold: 20 } }, metrics)?.verdict, "Contradicted");
  assert.equal(verdictByRule({ ...base, check: null }, metrics), null);
});

test("guardrail: flags numbers that aren't in the evidence", () => {
  assert.deepEqual(inventedNumbers("P/E is 23.8x and margin 9%", "pe 23.8 margin 9"), []);
  assert.deepEqual(inventedNumbers("Trades at 31.5x", "pe 23.8"), ["31.5"]);
});

test("full pipeline with a fake model", async () => {
  const card = await testThesis({
    symbol: "wabag",
    thesis: THESIS,
    wrongIf: ["Operating margin below 11% for 2 quarters in a row"],
    fundamentals: wabag(),
    concall: { available: false, redFlags: [], commitments: [] },
    llm: fakeLlm,
  });
  const byId = Object.fromEntries(card.claims.map((c) => [c.id, c]));
  assert.equal(card.symbol, "WABAG");
  assert.equal(byId.c6.verdictBy, "rule");
  assert.equal(byId.c6.verdict, "Contradicted"); // 10% CAGR vs ≥15% needed
  assert.equal(byId.c3.verdict, "Weak");
  assert.equal(byId.c4.confidence, "low"); // invented 31.5x caught
  assert.match(byId.c4.reason, /don't match the source data/);
  assert.equal(byId.c5.verdict, "Weak"); // Supported without evidence → downgraded
  assert.equal(card.triggerStatus[0].status, "ok"); // Mar 26 = 11.0, Jun 26 = 9.0 → not both below 11
  assert.equal(card.headline, "Shaky");
  assert.ok(card.blindSpots.length >= 5);
  assert.equal(card.coachingQuestions.length, 1);
});

test("recheck: a new weak quarter fires the trigger and breaks the thesis", async () => {
  const card = await testThesis({
    symbol: "WABAG", thesis: THESIS, wrongIf: ["Operating margin below 11% for 2 quarters in a row"],
    fundamentals: wabag(), concall: { available: false, redFlags: [], commitments: [] }, llm: fakeLlm,
  });
  const next = wabag();
  next.asOf = "2026-11-15";
  next.quarters.push({ period: "Sep 2026", sales: 900, operatingProfit: 72, otherIncome: 20, pbt: 75, netProfit: 56 });
  const { card: updated, changes } = recheckCard(card, next);
  assert.equal(updated.triggerStatus[0].status, "fired");
  assert.equal(updated.headline, "Broken");
  assert.ok(changes.some((c) => c.includes("condition fired")));
});

test("store: versions are kept", async () => {
  useThesisDb(join(mkdtempSync(join(tmpdir(), "thesis-")), "t.db"));
  const card = await testThesis({
    symbol: "WABAG", thesis: THESIS, fundamentals: wabag(),
    concall: { available: false, redFlags: [], commitments: [] }, llm: fakeLlm,
  });
  const id = saveNewThesis(card);
  addVersion(id, { ...card, headline: "Broken" }, "recheck", ["x"]);
  const latest = getLatest(id)!;
  assert.equal(latest.version, 2);
  assert.equal(latest.card.headline, "Broken");
  assert.equal(listTheses()[0].versions, 2);
});

test("checkTriggers: manual and missing-data cases", () => {
  const { metrics, series } = computeMetrics(wabag());
  const s = checkTriggers(
    [{ id: "a", text: "Management loses credibility", rule: null },
     { id: "b", text: "Margin < 5 for 9 quarters", rule: { metric: "core_margin_latest_q", op: "<", threshold: 5, consecutivePeriods: 9 } }],
    metrics, series
  );
  assert.equal(s[0].status, "manual");
  assert.equal(s[1].status, "no_data");
});
