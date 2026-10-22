/**
 * Deterministic rules: claim checks, blind spots, invalidation triggers and
 * the headline. No model calls in this file.
 */
import type {
  BlindSpot,
  Claim,
  ClaimResult,
  Evidence,
  InvalidationTrigger,
  MetricKey,
  MetricSeries,
  MetricSet,
  ThesisHeadline,
  TriggerOp,
  TriggerStatus,
  Verdict,
} from "./types.ts";

const ev = (metrics: MetricSet, key: MetricKey): Evidence[] => {
  const m = metrics[key];
  return m ? [{ text: `${m.label}: ${fmt(m.value, m.unit)} (${m.working})`, source: { kind: "metric", metric: key } }] : [];
};

export function fmt(value: number, unit: string): string {
  if (unit === "x") return `${value}x`;
  if (unit === "days") return `${value} days`;
  if (unit === "pp") return `${value > 0 ? "+" : ""}${value} pp`;
  return `${value}%`;
}

export function compare(value: number, op: TriggerOp, threshold: number): boolean {
  switch (op) {
    case "<": return value < threshold;
    case "<=": return value <= threshold;
    case ">": return value > threshold;
    case ">=": return value >= threshold;
  }
}

/* ------------------------------------------------------------------ */
/* Claim checks                                                        */
/* ------------------------------------------------------------------ */

/**
 * Decide a claim by rule when it carries a metric check.
 * - passes → Supported
 * - misses by ≤ 25% of the threshold → Weak (close, not there)
 * - misses by more → Contradicted
 * - metric missing → null (fall through to model or Unverifiable)
 */
export function verdictByRule(claim: Claim, metrics: MetricSet): ClaimResult | null {
  if (!claim.check) return null;
  const m = metrics[claim.check.metric];
  if (!m) return null;
  const { op, threshold } = claim.check;
  const passes = compare(m.value, op, threshold);
  const gap = Math.abs(m.value - threshold);
  const tolerance = Math.max(Math.abs(threshold) * 0.25, 1);
  const verdict: Verdict = passes ? "Supported" : gap <= tolerance ? "Weak" : "Contradicted";
  return {
    ...claim,
    verdict,
    verdictBy: "rule",
    confidence: "high",
    reason: `${m.label} is ${fmt(m.value, m.unit)}; the claim needs ${op} ${fmt(threshold, m.unit)}.`,
    evidence: ev(metrics, claim.check.metric),
  };
}

/* ------------------------------------------------------------------ */
/* Blind spots — things a careful analyst would raise unprompted       */
/* ------------------------------------------------------------------ */

export function findBlindSpots(metrics: MetricSet, claims: Claim[]): BlindSpot[] {
  const out: BlindSpot[] = [];
  const v = (k: MetricKey) => metrics[k]?.value;
  const mentions = (t: Claim["type"]) => claims.some((c) => c.type === t);

  const mNow = v("core_margin_latest_q");
  const mAgo = v("core_margin_year_ago_q");
  if (mNow !== undefined && mAgo !== undefined && mAgo - mNow >= 2) {
    out.push({
      id: "core_margin_drop",
      title: "Core operating margin fell",
      detail: `Operating margin before other income dropped from ${mAgo}% to ${mNow}% year on year.${mentions("margin") ? "" : " Your thesis doesn't mention margins."}`,
      severity: mAgo - mNow >= 3 ? "high" : "medium",
      evidence: [...ev(metrics, "core_margin_latest_q"), ...ev(metrics, "core_margin_year_ago_q")],
    });
  }

  const pat = v("pat_yoy_latest_q");
  const op = v("op_profit_yoy_latest_q");
  if (pat !== undefined && op !== undefined && pat - op >= 15) {
    out.push({
      id: "profit_outpacing_core",
      title: "Reported profit is growing much faster than core profit",
      detail: `Net profit grew ${pat}% but operating profit ${op < 0 ? `fell ${Math.abs(op)}` : `grew ${op}`}%. The gap usually comes from other income, one-offs or lower tax, which may not repeat.`,
      severity: op < 0 ? "high" : "medium",
      evidence: [...ev(metrics, "pat_yoy_latest_q"), ...ev(metrics, "op_profit_yoy_latest_q")],
    });
  }

  const oneOff = v("one_off_share_of_pbt_latest_q");
  if (oneOff !== undefined && oneOff >= 15) {
    out.push({
      id: "one_off_profit",
      title: "A large one-off boosted the latest quarter",
      detail: `Disclosed one-offs were ${oneOff}% of pre-tax profit last quarter.`,
      severity: oneOff >= 25 ? "high" : "medium",
      evidence: ev(metrics, "one_off_share_of_pbt_latest_q"),
    });
  }

  const oi = v("other_income_share_of_pbt_ttm");
  if (oi !== undefined && oi >= 20) {
    out.push({
      id: "other_income_reliance",
      title: "Profit leans on other income",
      detail: `Other income is ${oi}% of trailing pre-tax profit.`,
      severity: oi >= 30 ? "high" : "medium",
      evidence: ev(metrics, "other_income_share_of_pbt_ttm"),
    });
  }

  const cfo = v("cfo_to_pat_latest_fy");
  if (cfo !== undefined && cfo < 70) {
    out.push({
      id: "weak_cash_conversion",
      title: "Profits aren't fully turning into cash",
      detail: `Operating cash flow was only ${cfo}% of net profit last year.`,
      severity: cfo < 50 ? "high" : "medium",
      evidence: ev(metrics, "cfo_to_pat_latest_fy"),
    });
  }

  const dd = v("debtor_days_latest_fy");
  const ddChg = v("debtor_days_change_1y");
  if (dd !== undefined && (dd > 180 || (ddChg !== undefined && ddChg > 20))) {
    out.push({
      id: "slow_collections",
      title: "Customers take a long time to pay",
      detail: `Debtor days are ${dd}${ddChg !== undefined ? ` (${ddChg > 0 ? "+" : ""}${ddChg} vs last year)` : ""}.`,
      severity: dd > 240 || (ddChg ?? 0) > 40 ? "high" : "medium",
      evidence: [...ev(metrics, "debtor_days_latest_fy"), ...ev(metrics, "debtor_days_change_1y")],
    });
  }

  const pledge = v("promoter_pledge_pct");
  if (pledge !== undefined && pledge > 0) {
    out.push({
      id: "promoter_pledge",
      title: "Promoter shares are pledged",
      detail: `${pledge}% of promoter shares are pledged.`,
      severity: pledge >= 10 ? "high" : "medium",
      evidence: ev(metrics, "promoter_pledge_pct"),
    });
  }

  const ph = v("promoter_holding_pct");
  const phChg = v("promoter_holding_change_2y");
  if (ph !== undefined && (ph < 25 || (phChg !== undefined && phChg <= -2))) {
    out.push({
      id: "promoter_skin",
      title: phChg !== undefined && phChg <= -2 ? "Promoters have been selling" : "Low promoter holding",
      detail: `Promoters own ${ph}%${phChg !== undefined ? ` (${phChg > 0 ? "+" : ""}${phChg} pp over two years)` : ""}.`,
      severity: phChg !== undefined && phChg <= -5 ? "high" : "low",
      evidence: [...ev(metrics, "promoter_holding_pct"), ...ev(metrics, "promoter_holding_change_2y")],
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/* ------------------------------------------------------------------ */
/* Invalidation triggers                                               */
/* ------------------------------------------------------------------ */

export function checkTriggers(
  triggers: InvalidationTrigger[],
  metrics: MetricSet,
  series: MetricSeries
): TriggerStatus[] {
  return triggers.map((t) => {
    if (!t.rule) {
      return { triggerId: t.id, text: t.text, status: "manual", detail: "Can't be checked automatically. Review it each quarter." };
    }
    const { metric, op, threshold, consecutivePeriods } = t.rule;
    const s = series[metric];
    if (consecutivePeriods > 1 && s && s.length) {
      if (s.length < consecutivePeriods) {
        return { triggerId: t.id, text: t.text, status: "no_data", detail: `Need ${consecutivePeriods} quarters of ${metric}, have ${s.length}.` };
      }
      const window = s.slice(-consecutivePeriods);
      const fired = window.every((p) => compare(p.value, op, threshold));
      return {
        triggerId: t.id,
        text: t.text,
        status: fired ? "fired" : "ok",
        detail: window.map((p) => `${p.period}: ${p.value}`).join(", "),
      };
    }
    const m = metrics[metric];
    if (!m) return { triggerId: t.id, text: t.text, status: "no_data", detail: `No data for ${metric}.` };
    const fired = compare(m.value, op, threshold);
    return { triggerId: t.id, text: t.text, status: fired ? "fired" : "ok", detail: `${m.label}: ${fmt(m.value, m.unit)}` };
  });
}

/* ------------------------------------------------------------------ */
/* Headline — never a percentage                                       */
/* ------------------------------------------------------------------ */

export function countVerdicts(claims: ClaimResult[]): Record<Verdict, number> {
  const counts: Record<Verdict, number> = { Supported: 0, Weak: 0, Contradicted: 0, Unverifiable: 0, Pending: 0 };
  for (const c of claims) counts[c.verdict]++;
  return counts;
}

export function headline(
  claims: ClaimResult[],
  blindSpots: BlindSpot[],
  triggerStatus: TriggerStatus[]
): { headline: ThesisHeadline; reason: string } {
  if (!claims.length) {
    return { headline: "Too vague", reason: "No checkable claims found. Say what the company will do and by when." };
  }
  const fired = triggerStatus.filter((t) => t.status === "fired");
  if (fired.length) {
    return { headline: "Broken", reason: `Your own "I'm wrong if" condition fired: ${fired[0].text}` };
  }
  const core = claims.filter((c) => c.importance === "core");
  const coreOrAll = core.length ? core : claims;
  const contradicted = coreOrAll.filter((c) => c.verdict === "Contradicted");
  if (contradicted.length) {
    return { headline: "Broken", reason: `A core claim is contradicted by the data: "${contradicted[0].text}"` };
  }
  if (coreOrAll.every((c) => c.isMacro)) {
    return {
      headline: "Too vague",
      reason: "Every core reason is about the world, not this company. Tie each one to the company's own numbers.",
    };
  }
  const shaky = coreOrAll.filter((c) => c.verdict === "Weak" || c.verdict === "Unverifiable");
  const highSpots = blindSpots.filter((b) => b.severity === "high");
  if (shaky.length) {
    return {
      headline: "Shaky",
      reason: `${shaky.length} core claim${shaky.length > 1 ? "s are" : " is"} weak or unproven, starting with "${shaky[0].text}".`,
    };
  }
  if (highSpots.length) {
    return { headline: "Shaky", reason: `Core claims hold, but there's a serious blind spot: ${highSpots[0].title.toLowerCase()}.` };
  }
  return { headline: "Holds", reason: "Core claims are supported by the data so far." };
}
