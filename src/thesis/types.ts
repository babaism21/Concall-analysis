/**
 * Thesis Tester — core types.
 *
 * A thesis is split into atomic claims. Each claim gets a verdict backed by
 * evidence. We never say "X% of your thesis is right"; we show claim-level
 * verdicts, blind spots, coaching questions and the user's own
 * "I'm wrong if…" conditions.
 */

export type ClaimType =
  | "growth"
  | "margin"
  | "moat"
  | "management"
  | "valuation"
  | "tailwind"
  | "catalyst"
  | "balance_sheet"
  | "other";

/** core = the reason to buy; supporting = nice to have. */
export type ClaimImportance = "core" | "supporting";

export type Verdict = "Supported" | "Weak" | "Contradicted" | "Unverifiable" | "Pending";

export type EvidenceSource =
  | { kind: "metric"; metric: MetricKey; period?: string }
  | { kind: "concall"; quarter?: string; sourceUrl?: string; quote?: string }
  | { kind: "fundamentals"; field: string };

export type Evidence = {
  text: string;
  source: EvidenceSource;
};

export type Claim = {
  id: string;
  text: string;
  type: ClaimType;
  importance: ClaimImportance;
  /** True when the claim is about the world (e.g. "water demand will rise"), not this company. */
  isMacro: boolean;
  /**
   * For quantitative claims: the metric test that decides the verdict by rule,
   * e.g. "revenue will grow 20%" → { metric: "revenue_cagr_3y", op: ">=", threshold: 20 }.
   */
  check: { metric: MetricKey; op: TriggerOp; threshold: number } | null;
};

export type ClaimResult = Claim & {
  verdict: Verdict;
  /** How the verdict was reached: deterministic rule or model judgement. */
  verdictBy: "rule" | "model";
  confidence: "high" | "medium" | "low";
  reason: string;
  evidence: Evidence[];
};

export type BlindSpot = {
  id: string;
  title: string;
  detail: string;
  severity: "high" | "medium" | "low";
  evidence: Evidence[];
};

/** A machine-checkable "I'm wrong if…" condition. */
export type TriggerOp = "<" | "<=" | ">" | ">=";

export type InvalidationTrigger = {
  id: string;
  /** What the user wrote, verbatim. */
  text: string;
  /** Structured form when it can be checked automatically; null = review manually. */
  rule: {
    metric: MetricKey;
    op: TriggerOp;
    threshold: number;
    /** Must hold for N consecutive latest periods (quarterly metrics only). */
    consecutivePeriods: number;
  } | null;
};

export type TriggerStatus = {
  triggerId: string;
  text: string;
  status: "fired" | "ok" | "manual" | "no_data";
  detail: string;
};

export type ThesisHeadline = "Holds" | "Shaky" | "Broken" | "Too vague";

export type ThesisCard = {
  symbol: string;
  thesisText: string;
  headline: ThesisHeadline;
  headlineReason: string;
  counts: Record<Verdict, number>;
  claims: ClaimResult[];
  blindSpots: BlindSpot[];
  coachingQuestions: string[];
  /** Suggested thesis rewrite focused on what the evidence actually supports. */
  suggestedRewrite: string | null;
  triggers: InvalidationTrigger[];
  triggerStatus: TriggerStatus[];
  /** Suggestions shown when the user wrote no "I'm wrong if…" conditions. */
  suggestedTriggers: InvalidationTrigger[];
  metrics: MetricSet;
  dataAsOf: string | null;
  modelId: string | null;
  engineVersion: string;
  createdAt: string;
  disclaimer: string;
};

/* ------------------------------------------------------------------ */
/* Fundamentals contract — what any data provider must return.         */
/* All money in ₹ crore. Periods oldest → newest.                      */
/* ------------------------------------------------------------------ */

export type QuarterRow = {
  period: string; // e.g. "Jun 2026"
  sales: number;
  operatingProfit: number; // before other income
  otherIncome: number;
  pbt: number;
  netProfit: number;
};

export type AnnualRow = {
  period: string; // e.g. "Mar 2026" or "TTM"
  sales: number;
  operatingProfit: number;
  otherIncome: number;
  pbt: number;
  netProfit: number;
  cfo?: number; // cash from operations
  debtorDays?: number;
  borrowings?: number;
  cash?: number;
};

export type Fundamentals = {
  symbol: string;
  name: string;
  asOf: string; // ISO date the data was pulled
  price: number;
  marketCapCr: number;
  quarters: QuarterRow[];
  annual: AnnualRow[];
  /** Consensus estimates, if available. */
  forwardEps?: Array<{ fiscalYear: string; eps: number }>;
  promoterHoldingPct?: Array<{ period: string; pct: number }>;
  promoterPledgePct?: number;
  /** Most recent cash and debt, which may be a quarter-end (e.g. from an investor presentation). */
  latestCash?: { period: string; cashCr: number; borrowingsCr: number; source?: string };
  /** Disclosed one-offs inside other income (e.g. forex gains), keyed by period. */
  disclosedOneOffs?: Array<{ period: string; amountCr: number; label: string; source?: string }>;
  /** Business mix from filings / presentations, e.g. { "industrial_orderbook_pct": 12 }. */
  segmentFacts?: Array<{ key: string; value: number; label: string; source?: string }>;
};

export type MetricKey =
  | "revenue_yoy_latest_q"
  | "op_profit_yoy_latest_q"
  | "core_margin_latest_q"
  | "core_margin_year_ago_q"
  | "core_margin_trailing_avg"
  | "pat_yoy_latest_q"
  | "other_income_share_of_pbt_ttm"
  | "revenue_cagr_3y"
  | "pat_cagr_3y"
  | "cfo_to_pat_latest_fy"
  | "debtor_days_latest_fy"
  | "debtor_days_change_1y"
  | "pe_trailing"
  | "pe_forward_1"
  | "pe_forward_2"
  | "net_cash_pct_mcap"
  | "promoter_holding_pct"
  | "promoter_holding_change_2y"
  | "promoter_pledge_pct"
  | "one_off_share_of_pbt_latest_q";

export type MetricValue = {
  key: MetricKey;
  label: string;
  value: number;
  unit: "%" | "x" | "days" | "pp";
  /** Plain-English working, so every number can be checked. */
  working: string;
};

export type MetricSet = Partial<Record<MetricKey, MetricValue>>;

/** Quarterly series used for "N quarters in a row" triggers. */
export type MetricSeries = Partial<Record<MetricKey, Array<{ period: string; value: number }>>>;

export type ConcallContext = {
  available: boolean;
  healthScore?: number;
  label?: string;
  redFlags: string[];
  commitments: Array<{ quarter: string; commitment: string; status: string; evidence: string }>;
  latestSourceUrl?: string | null;
};
