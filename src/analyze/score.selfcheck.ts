/**
 * Tiny self-check for unified management-health scoring (no test runner in repo).
 * Run: npx tsx src/analyze/score.selfcheck.ts
 *
 * Worked example (ASK-like mix):
 *   Met, Not Met, Under Execution, Early Execution, Partially Completed
 *   → weights 100, 12, 74, 70, 78 → mean 66.8 → Average (not Weak from old open penalties)
 *
 * Empty-commitment path uses insight kinds (not raw callScore×10), so a name with
 * only glossy LLM callScores cannot silently outrank a stock with real misses.
 */
import {
  buildQuarterTimeline,
  dedupeTimeline,
  recomputePortfolioScores,
  scoreHeadline,
  STATUS_WEIGHT,
  type Commitment,
  type Insight,
  type PortfolioJson,
} from "./score.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function approx(a: number, b: number, tol = 1): boolean {
  return Math.abs(a - b) <= tol;
}

const mixed: Commitment[] = [
  { quarter: "Q1FY26", commitment: "a", status: "Met", evidence: "" },
  { quarter: "Q1FY26", commitment: "b", status: "Not Met", evidence: "" },
  { quarter: "Q2FY26", commitment: "c", status: "Under Execution", evidence: "" },
  { quarter: "Q2FY26", commitment: "d", status: "Early Execution", evidence: "" },
  { quarter: "Q3FY26", commitment: "e", status: "Partially Completed", evidence: "" },
];

const outcomeOnly = scoreHeadline({ commitments: mixed, timeline: [], redFlags: [] });
const expectedMean = Math.round(
  (STATUS_WEIGHT.Met +
    STATUS_WEIGHT["Not Met"] +
    STATUS_WEIGHT["Under Execution"] +
    STATUS_WEIGHT["Early Execution"] +
    STATUS_WEIGHT["Partially Completed"]) /
    5
);
assert(approx(outcomeOnly.healthScore, expectedMean), `mixed mean ~${expectedMean}, got ${outcomeOnly.healthScore}`);
assert(outcomeOnly.label === "Average", `expected Average, got ${outcomeOnly.label}`);

// Open-only book should not land Weak (old Under=50 / Early=30 did).
const openOnly = scoreHeadline({
  commitments: [
    { quarter: "Q1FY26", commitment: "x", status: "Under Execution", evidence: "" },
    { quarter: "Q2FY26", commitment: "y", status: "Early Execution", evidence: "" },
  ],
  redFlags: [],
});
assert(openOnly.healthScore >= 70, `open work should score ≥70, got ${openOnly.healthScore}`);
assert(openOnly.label === "Average" || openOnly.label === "Good", "open work not Weak");

// Empty commitments: insight path, not callScore×10 inflation.
const glossyInsights: Insight[] = [
  { id: "1", kind: "positive", title: "p", body: "", quarter: "Q1FY26", quote: "" },
  { id: "2", kind: "negative", title: "n", body: "", quarter: "Q1FY26", quote: "" },
  { id: "3", kind: "risk", title: "r", body: "", quarter: "Q1FY26", quote: "" },
  { id: "4", kind: "guidance", title: "g", body: "", quarter: "Q1FY26", quote: "" },
];
const emptyCommit = scoreHeadline({
  commitments: [],
  insights: glossyInsights,
  timeline: [
    { quarter: "Q1FY26", score: 8.5, note: "strong" },
    { quarter: "Q2FY26", score: 8.2, note: "strong" },
  ],
  redFlags: [],
});
assert(
  emptyCommit.healthScore < 80,
  `empty-commitment must not inherit 85 callScore regime, got ${emptyCommit.healthScore}`
);

// Timeline: one row per quarter; no artificial uniqueness nudge.
const tl = buildQuarterTimeline({
  calls: [
    { quarter: "Q4FY26", callScore: 8, summary: "regular" },
    { quarter: "Q4FY26", callScore: 6, summary: "emergency" },
    { quarter: "Q1FY27", callScore: 7, summary: "next" },
  ],
  commitments: [],
  insights: [],
  redFlags: [],
});
assert(tl.length === 2, `expected 2 quarters after dedupe, got ${tl.length}`);
assert(tl[0].quarter === "Q4FY26", "chronological Q4 first");
assert(approx(tl[0].score, 7.0, 0.2), `Q4 avg of 8+6 ≈7, got ${tl[0].score}`);

const duped = dedupeTimeline([
  { quarter: "Q2FY25", score: 5.3, note: "a" },
  { quarter: "Q2FY25", score: 7.1, note: "b" },
  { quarter: "Q3FY25", score: 8, note: "c" },
]);
assert(duped.length === 2, "dedupe collapses Q2FY25");
assert(approx(duped[0].score, 6.2, 0.2), `avg 5.3/7.1 ≈6.2, got ${duped[0].score}`);

// Identical evidence → identical scores (no rank spread).
const flat = buildQuarterTimeline({
  calls: [
    { quarter: "Q1FY26", callScore: 7 },
    { quarter: "Q2FY26", callScore: 7 },
    { quarter: "Q3FY26", callScore: 7 },
  ],
  commitments: [],
});
assert(
  flat.every((e) => e.score === flat[0].score),
  `equal evidence must stay equal, got ${flat.map((e) => e.score).join(",")}`
);

const portfolio: PortfolioJson = {
  symbol: "TEST",
  healthScore: 99,
  label: "Good",
  rawScore: 9,
  redFlags: ["flag A", "flag B"],
  commitments: mixed,
  insights: [],
  timeline: [
    { quarter: "Q1FY26", score: 5, note: "x" },
    { quarter: "Q1FY26", score: 7, note: "dup" },
  ],
  summary: "",
  transcriptCount: 2,
  latestSourceUrl: null,
  scoredAt: "",
};
const recomputed = recomputePortfolioScores(portfolio);
assert(recomputed.timeline.length === 1, "rescore dedupes without seeds");
assert(recomputed.healthScore <= 100 && recomputed.healthScore >= 0, "in range");
assert(recomputed.healthScore !== 99, "headline refreshed");

console.log("score.selfcheck: OK");
console.log(
  JSON.stringify(
    {
      mixedCommitments: outcomeOnly,
      openOnly,
      emptyCommitInsightPath: emptyCommit,
      dedupedTimeline: tl,
    },
    null,
    2
  )
);
