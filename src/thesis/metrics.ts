/**
 * Deterministic metrics. The model never computes numbers — it only sees
 * these values and their working. Every metric carries a plain-English
 * "working" string so a user can check the arithmetic.
 */
import type {
  AnnualRow,
  Fundamentals,
  MetricKey,
  MetricSeries,
  MetricSet,
  MetricValue,
  QuarterRow,
} from "./types.ts";

const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (num: number, den: number) => (den === 0 ? NaN : (num / den) * 100);
const growth = (now: number, then: number) =>
  then <= 0 ? NaN : ((now - then) / then) * 100;
const cr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")} cr`;

function put(
  set: MetricSet,
  key: MetricKey,
  label: string,
  value: number,
  unit: MetricValue["unit"],
  working: string
) {
  if (!Number.isFinite(value)) return;
  set[key] = { key, label, value: r1(value), unit, working };
}

const coreMargin = (q: QuarterRow) => pct(q.operatingProfit, q.sales);

/** Same quarter one year earlier, matched by month name (e.g. "Jun 2026" → "Jun 2025"). */
export function yearAgoQuarter(quarters: QuarterRow[], idx: number): QuarterRow | null {
  const cur = quarters[idx];
  const [mon, yr] = cur.period.split(" ");
  const target = `${mon} ${Number(yr) - 1}`;
  return quarters.find((q) => q.period === target) ?? null;
}

function fiscalYears(annual: AnnualRow[]): AnnualRow[] {
  return annual.filter((a) => a.period !== "TTM");
}

function ttm(f: Fundamentals): AnnualRow | null {
  const explicit = f.annual.find((a) => a.period === "TTM");
  if (explicit) return explicit;
  if (f.quarters.length < 4) return null;
  const last4 = f.quarters.slice(-4);
  const sum = (k: keyof QuarterRow) => last4.reduce((s, q) => s + (q[k] as number), 0);
  return {
    period: "TTM",
    sales: sum("sales"),
    operatingProfit: sum("operatingProfit"),
    otherIncome: sum("otherIncome"),
    pbt: sum("pbt"),
    netProfit: sum("netProfit"),
  };
}

export function computeMetrics(f: Fundamentals): { metrics: MetricSet; series: MetricSeries } {
  const m: MetricSet = {};
  const series: MetricSeries = {};
  const qs = f.quarters;

  /* ---------------- quarterly series ---------------- */
  series.core_margin_latest_q = qs.map((q) => ({ period: q.period, value: r1(coreMargin(q)) }));
  const yoySeries = (key: MetricKey, pick: (q: QuarterRow) => number) => {
    const out: Array<{ period: string; value: number }> = [];
    qs.forEach((q, i) => {
      const prev = yearAgoQuarter(qs, i);
      if (!prev) return;
      const g = growth(pick(q), pick(prev));
      if (Number.isFinite(g)) out.push({ period: q.period, value: r1(g) });
    });
    series[key] = out;
  };
  yoySeries("revenue_yoy_latest_q", (q) => q.sales);
  yoySeries("op_profit_yoy_latest_q", (q) => q.operatingProfit);
  yoySeries("pat_yoy_latest_q", (q) => q.netProfit);

  /* ---------------- latest quarter ---------------- */
  if (qs.length) {
    const li = qs.length - 1;
    const latest = qs[li];
    const ago = yearAgoQuarter(qs, li);
    put(
      m,
      "core_margin_latest_q",
      `Operating margin excl. other income (${latest.period})`,
      coreMargin(latest),
      "%",
      `${cr(latest.operatingProfit)} ÷ ${cr(latest.sales)}`
    );
    const tail = qs.slice(-4);
    put(
      m,
      "core_margin_trailing_avg",
      "Operating margin, last 4 quarters",
      pct(
        tail.reduce((s, q) => s + q.operatingProfit, 0),
        tail.reduce((s, q) => s + q.sales, 0)
      ),
      "%",
      `sum of operating profit ÷ sum of sales over ${tail.map((q) => q.period).join(", ")}`
    );
    if (ago) {
      put(
        m,
        "core_margin_year_ago_q",
        `Operating margin excl. other income (${ago.period})`,
        coreMargin(ago),
        "%",
        `${cr(ago.operatingProfit)} ÷ ${cr(ago.sales)}`
      );
      put(
        m,
        "revenue_yoy_latest_q",
        `Revenue growth YoY (${latest.period})`,
        growth(latest.sales, ago.sales),
        "%",
        `${cr(latest.sales)} vs ${cr(ago.sales)} in ${ago.period}`
      );
      put(
        m,
        "op_profit_yoy_latest_q",
        `Operating profit growth YoY (${latest.period})`,
        growth(latest.operatingProfit, ago.operatingProfit),
        "%",
        `${cr(latest.operatingProfit)} vs ${cr(ago.operatingProfit)} in ${ago.period}`
      );
      put(
        m,
        "pat_yoy_latest_q",
        `Net profit growth YoY (${latest.period})`,
        growth(latest.netProfit, ago.netProfit),
        "%",
        `${cr(latest.netProfit)} vs ${cr(ago.netProfit)} in ${ago.period}`
      );
    }
    const oneOff = (f.disclosedOneOffs ?? [])
      .filter((o) => o.period === latest.period)
      .reduce((s, o) => s + o.amountCr, 0);
    if (oneOff !== 0) {
      put(
        m,
        "one_off_share_of_pbt_latest_q",
        `Disclosed one-offs as share of pre-tax profit (${latest.period})`,
        pct(oneOff, latest.pbt),
        "%",
        `${cr(oneOff)} one-offs ÷ ${cr(latest.pbt)} pre-tax profit`
      );
    }
  }

  /* ---------------- trailing / annual ---------------- */
  const t = ttm(f);
  if (t) {
    put(
      m,
      "other_income_share_of_pbt_ttm",
      "Other income as share of pre-tax profit (TTM)",
      pct(t.otherIncome, t.pbt),
      "%",
      `${cr(t.otherIncome)} ÷ ${cr(t.pbt)}`
    );
    put(
      m,
      "pe_trailing",
      "P/E on trailing profit",
      f.marketCapCr / t.netProfit,
      "x",
      `market cap ${cr(f.marketCapCr)} ÷ TTM profit ${cr(t.netProfit)}`
    );
  }

  const fy = fiscalYears(f.annual);
  if (fy.length >= 4) {
    const now = fy[fy.length - 1];
    const then = fy[fy.length - 4];
    // A base year that is tiny (e.g. a one-off loss year) makes CAGR meaningless — skip it.
    const cagr = (a: number, b: number) => (b <= 0 || a / b > 8 ? NaN : (Math.pow(a / b, 1 / 3) - 1) * 100);
    put(
      m,
      "revenue_cagr_3y",
      `Revenue CAGR, ${then.period} → ${now.period}`,
      cagr(now.sales, then.sales),
      "%",
      `${cr(then.sales)} → ${cr(now.sales)} over 3 years`
    );
    put(
      m,
      "pat_cagr_3y",
      `Net profit CAGR, ${then.period} → ${now.period}`,
      cagr(now.netProfit, then.netProfit),
      "%",
      `${cr(then.netProfit)} → ${cr(now.netProfit)} over 3 years`
    );
  }
  const lastFy = fy[fy.length - 1];
  if (lastFy?.cfo !== undefined) {
    put(
      m,
      "cfo_to_pat_latest_fy",
      `Operating cash flow ÷ net profit (${lastFy.period})`,
      pct(lastFy.cfo, lastFy.netProfit),
      "%",
      `${cr(lastFy.cfo)} ÷ ${cr(lastFy.netProfit)}`
    );
  }
  if (lastFy?.debtorDays !== undefined) {
    put(
      m,
      "debtor_days_latest_fy",
      `Debtor days (${lastFy.period})`,
      lastFy.debtorDays,
      "days",
      `as reported`
    );
    const prevFy = fy[fy.length - 2];
    if (prevFy?.debtorDays !== undefined) {
      put(
        m,
        "debtor_days_change_1y",
        `Change in debtor days, ${prevFy.period} → ${lastFy.period}`,
        lastFy.debtorDays - prevFy.debtorDays,
        "days",
        `${prevFy.debtorDays} → ${lastFy.debtorDays}`
      );
    }
  }
  const bs = f.latestCash
    ? { period: f.latestCash.period, cash: f.latestCash.cashCr, borrowings: f.latestCash.borrowingsCr }
    : [...fy].reverse().find((a) => a.cash !== undefined && a.borrowings !== undefined);
  if (bs) {
    const net = (bs.cash as number) - (bs.borrowings as number);
    put(
      m,
      "net_cash_pct_mcap",
      `Net cash as share of market cap (${bs.period})`,
      pct(net, f.marketCapCr),
      "%",
      `(cash ${cr(bs.cash as number)} − borrowings ${cr(bs.borrowings as number)}) ÷ ${cr(f.marketCapCr)}`
    );
  }

  /* ---------------- valuation ---------------- */
  const fwd = f.forwardEps ?? [];
  if (fwd[0]) {
    put(m, "pe_forward_1", `P/E on ${fwd[0].fiscalYear} consensus EPS`, f.price / fwd[0].eps, "x",
      `price ₹${f.price} ÷ EPS ₹${fwd[0].eps}`);
  }
  if (fwd[1]) {
    put(m, "pe_forward_2", `P/E on ${fwd[1].fiscalYear} consensus EPS`, f.price / fwd[1].eps, "x",
      `price ₹${f.price} ÷ EPS ₹${fwd[1].eps}`);
  }

  /* ---------------- ownership ---------------- */
  const ph = f.promoterHoldingPct ?? [];
  if (ph.length) {
    const last = ph[ph.length - 1];
    put(m, "promoter_holding_pct", `Promoter holding (${last.period})`, last.pct, "%", "as reported");
    const twoYrAgo = ph[ph.length - 9];
    if (twoYrAgo) {
      put(m, "promoter_holding_change_2y", `Change in promoter holding since ${twoYrAgo.period}`,
        last.pct - twoYrAgo.pct, "pp", `${twoYrAgo.pct}% → ${last.pct}%`);
    }
  }
  if (f.promoterPledgePct !== undefined) {
    put(m, "promoter_pledge_pct", "Promoter shares pledged", f.promoterPledgePct, "%", "as reported");
  }

  return { metrics: m, series };
}

/** Compact text block handed to the model: values plus working, nothing else. */
export function metricsForPrompt(metrics: MetricSet, f: Fundamentals): string {
  const lines = Object.values(metrics).map(
    (v) => `- ${v!.key}: ${v!.label} = ${v!.value}${v!.unit === "x" ? "x" : v!.unit === "days" ? " days" : v!.unit === "pp" ? " pp" : "%"} (${v!.working})`
  );
  for (const s of f.segmentFacts ?? []) {
    lines.push(`- segment:${s.key}: ${s.label} = ${s.value}${s.source ? ` (source: ${s.source})` : ""}`);
  }
  for (const o of f.disclosedOneOffs ?? []) {
    lines.push(`- one_off: ${o.label} in ${o.period} = ₹${o.amountCr} cr${o.source ? ` (source: ${o.source})` : ""}`);
  }
  return lines.join("\n");
}
