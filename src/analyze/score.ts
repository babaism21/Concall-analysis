export type CommitmentStatus =
  | "Met"
  | "Partially Completed"
  | "Under Execution"
  | "Early Execution"
  | "Not Met";

export type Commitment = {
  quarter: string;
  commitment: string;
  status: CommitmentStatus;
  evidence: string;
  /** Verbatim span from a transcript when available (for deep-link). */
  quote?: string;
  callDate?: string;
  sourceUrl?: string;
  charOffset?: number;
};

export type TimelineEntry = {
  quarter: string;
  score: number;
  note: string;
};

/** UI card that deep-links into a transcript. */
export type Insight = {
  id: string;
  kind:
    | "delivered"
    | "missed"
    | "open"
    | "risk"
    | "guidance"
    | "positive"
    | "negative";
  title: string;
  body: string;
  quarter: string;
  status?: CommitmentStatus;
  quote: string;
  callDate?: string;
  sourceUrl?: string;
  charOffset?: number;
};

export type PortfolioJson = {
  symbol: string;
  healthScore: number; // 0-100 deterministic
  label: "Good" | "Average" | "Weak";
  rawScore: number | null; // LLM 0-10
  redFlags: string[];
  commitments: Commitment[];
  insights: Insight[];
  timeline: TimelineEntry[];
  summary: string;
  transcriptCount: number;
  latestSourceUrl: string | null;
  scoredAt: string;
};

export type DeliveryBucket = "delivered" | "missed" | "open";

/**
 * Points contributed to the headline average (0–100).
 *
 * Open work (Under / Early Execution) is healthy ongoing delivery — not a miss.
 * Prior weights (50 / 30) pulled otherwise-solid names into Average/Weak.
 */
export const STATUS_WEIGHT: Record<CommitmentStatus, number> = {
  Met: 100,
  "Partially Completed": 78,
  "Under Execution": 74,
  "Early Execution": 70,
  "Not Met": 12,
};

/** Soft points when inferring outcomes from insight cards (no commitments). */
const INSIGHT_KIND_WEIGHT: Record<Insight["kind"], number> = {
  delivered: 100,
  positive: 82,
  open: 72,
  guidance: 70,
  risk: 38,
  negative: 28,
  missed: 12,
};

const STATUS_ALIASES: Record<string, CommitmentStatus> = {
  met: "Met",
  "partially completed": "Partially Completed",
  partial: "Partially Completed",
  "under execution": "Under Execution",
  "early execution": "Early Execution",
  "not met": "Not Met",
  missed: "Not Met",
};

export function normalizeStatus(raw: string): CommitmentStatus | null {
  const key = raw.trim().toLowerCase();
  return STATUS_ALIASES[key] ?? null;
}

export function deliveryBucket(status: CommitmentStatus): DeliveryBucket {
  if (status === "Met" || status === "Partially Completed") return "delivered";
  if (status === "Not Met") return "missed";
  return "open";
}

export function labelFromHealthScore(healthScore: number): PortfolioJson["label"] {
  if (healthScore >= 75) return "Good";
  if (healthScore >= 50) return "Average";
  return "Weak";
}

function mean(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function clamp100(n: number): number {
  return Math.round(Math.min(100, Math.max(0, n)));
}

/**
 * Deterministic headline score — one path for every stock.
 *
 * 1. Prefer commitment status weights when any commitments exist.
 * 2. Else infer from insight kinds (same 0–100 scale; no LLM callScore shortcut).
 * 3. Blend lightly with per-quarter timeline (×10) so headline tracks call evidence.
 * 4. Apply a capped red-flag haircut.
 */
export function scoreHeadline(input: {
  commitments: Commitment[];
  insights?: Insight[];
  timeline?: TimelineEntry[];
  redFlags?: string[];
}): { healthScore: number; label: PortfolioJson["label"] } {
  const commitments = input.commitments ?? [];
  const insights = input.insights ?? [];
  const timeline = input.timeline ?? [];
  const redFlags = input.redFlags ?? [];

  let outcomeAvg: number | null = null;
  if (commitments.length > 0) {
    outcomeAvg = mean(commitments.map((c) => STATUS_WEIGHT[c.status] ?? 0));
  } else {
    const scoredInsights = insights.filter((i) => i.kind in INSIGHT_KIND_WEIGHT);
    if (scoredInsights.length > 0) {
      outcomeAvg = mean(scoredInsights.map((i) => INSIGHT_KIND_WEIGHT[i.kind]));
    }
  }

  const quarterAvg100 =
    timeline.length > 0
      ? mean(timeline.map((t) => Number(t.score)).filter((n) => Number.isFinite(n))) * 10
      : null;

  let blended: number;
  if (outcomeAvg != null && quarterAvg100 != null) {
    // Commitments / insight outcomes dominate; quarters keep headline coherent with chips.
    blended = 0.65 * outcomeAvg + 0.35 * quarterAvg100;
  } else if (outcomeAvg != null) {
    blended = outcomeAvg;
  } else if (quarterAvg100 != null) {
    // No commitments and no usable insights — timeline only, with uncertainty haircut
    // so empty-evidence names cannot outrank proven delivery track records.
    blended = quarterAvg100 * 0.88;
  } else {
    blended = 40;
  }

  const flagHaircut = Math.min(12, redFlags.length * 3);
  const healthScore = clamp100(blended - flagHaircut);
  return { healthScore, label: labelFromHealthScore(healthScore) };
}

/** @deprecated Prefer scoreHeadline — kept as a thin wrapper for callers. */
export function scoreFromCommitments(commitments: Commitment[]): {
  healthScore: number;
  label: PortfolioJson["label"];
} {
  return scoreHeadline({ commitments });
}

/** Fallback: parse commitments table from markdown if JSON extract is thin. */
export function parseCommitmentsFromMarkdown(md: string): Commitment[] {
  const rows: Commitment[] = [];
  for (const line of md.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    if (/^\|\s*-+/.test(line) || /Commitment/i.test(line)) continue;
    const cols = line
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cols.length < 3) continue;
    const status = normalizeStatus(cols[2]);
    if (!status) continue;
    rows.push({
      quarter: cols[0],
      commitment: cols[1],
      status,
      evidence: cols[3] ?? "",
      quote: cols[3] ?? "",
    });
  }
  return rows;
}

export function parseRedFlagsFromMarkdown(md: string): string[] {
  const idx = md.search(/##\s*Red Flags/i);
  if (idx < 0) return [];
  const slice = md.slice(idx).split(/\n##\s+/)[0];
  if (/none material/i.test(slice)) return [];
  return slice
    .split("\n")
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l && !/^##/.test(l) && !/^red flags$/i.test(l));
}

export function buildInsightsFromCommitments(
  commitments: Commitment[],
  redFlags: string[]
): Insight[] {
  const insights: Insight[] = commitments.map((c, i) => {
    const bucket = deliveryBucket(c.status);
    const kind =
      bucket === "delivered" ? "delivered" : bucket === "missed" ? "missed" : "open";
    return {
      id: `c-${i}`,
      kind,
      title: c.commitment,
      body: c.evidence || c.commitment,
      quarter: c.quarter,
      status: c.status,
      quote: (c.quote || c.evidence || c.commitment).slice(0, 280),
      callDate: c.callDate,
      sourceUrl: c.sourceUrl,
      charOffset: c.charOffset,
    };
  });

  redFlags.forEach((flag, i) => {
    insights.push({
      id: `r-${i}`,
      kind: "risk",
      title: flag.slice(0, 100) + (flag.length > 100 ? "…" : ""),
      body: flag,
      quarter: "",
      quote: flag.slice(0, 180),
    });
  });

  return insights;
}

/** Normalize whitespace for fuzzy quote search. */
export function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Find quote in transcript text. Tries exact, then collapsed-whitespace, then a short needle.
 * Returns char offset into the original `text`, or -1.
 */
export function findQuoteOffset(text: string, quote: string): number {
  if (!text || !quote) return -1;
  const q = quote.trim();
  if (q.length < 12) return -1;

  let idx = text.indexOf(q);
  if (idx >= 0) return idx;

  const needle = collapseWs(q);
  if (needle.length < 12) return -1;

  // Sliding window on collapsed form is expensive; approximate via first 48 chars.
  const short = needle.slice(0, Math.min(64, needle.length));
  const collapsedText = collapseWs(text);
  const cIdx = collapsedText.indexOf(short);
  if (cIdx < 0) return -1;

  // Map back roughly: walk original until collapsed length reaches cIdx
  let collapsedLen = 0;
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isSpace = /\s/.test(ch);
    if (isSpace) {
      if (!inSpace && collapsedLen > 0) {
        collapsedLen += 1;
        inSpace = true;
      }
    } else {
      collapsedLen += 1;
      inSpace = false;
    }
    if (collapsedLen >= cIdx + 1) return Math.max(0, i - short.length);
  }
  return -1;
}

export type TranscriptRef = {
  callDate: string;
  fyQuarter: string;
  sourceUrl: string;
  text: string;
};

/** Attach charOffset / callDate / sourceUrl onto commitments + insights. */
export function attachTranscriptAnchors(
  portfolio: PortfolioJson,
  transcripts: TranscriptRef[]
): PortfolioJson {
  const byQuarter = new Map<string, TranscriptRef[]>();
  for (const t of transcripts) {
    const list = byQuarter.get(t.fyQuarter) ?? [];
    list.push(t);
    byQuarter.set(t.fyQuarter, list);
  }

  const pickTranscript = (
    quarterLabel: string,
    callDate?: string,
    sourceUrl?: string
  ): TranscriptRef | undefined => {
    if (sourceUrl) {
      const byUrl = transcripts.find((t) => t.sourceUrl === sourceUrl);
      if (byUrl) return byUrl;
    }
    if (callDate) {
      const byDate = transcripts.find((t) => t.callDate === callDate);
      if (byDate) return byDate;
    }
    const q = quarterLabel.match(/Q[1-4]FY\d{2}/i)?.[0]?.toUpperCase();
    if (q && byQuarter.has(q)) return byQuarter.get(q)![0];
    return transcripts[0];
  };

  /** Prefer verbatim quote; else hunt for a distinctive phrase from title/evidence. */
  function resolveAnchor(
    t: TranscriptRef | undefined,
    quote: string,
    fallbackPhrases: string[]
  ): { quote: string; charOffset?: number } {
    if (!t) return { quote };
    const attempts = [quote, ...fallbackPhrases].map((s) => s.trim()).filter((s) => s.length >= 8);
    for (const attempt of attempts) {
      const found = findQuoteOffset(t.text, attempt);
      if (found >= 0) {
        // Expand to a readable window around the hit for highlighting
        const slice = t.text.slice(found, found + Math.min(120, Math.max(attempt.length, 40)));
        return { quote: slice.trim(), charOffset: found };
      }
    }
    // Token hunt: longest 3–6 word ngram from commitment that appears in text
    for (const phrase of fallbackPhrases) {
      const words = phrase.split(/\s+/).filter(Boolean);
      for (let n = Math.min(6, words.length); n >= 3; n--) {
        for (let i = 0; i + n <= words.length; i++) {
          const ngram = words.slice(i, i + n).join(" ");
          if (ngram.length < 12) continue;
          const found = findQuoteOffset(t.text, ngram);
          if (found >= 0) {
            const slice = t.text.slice(found, found + Math.min(140, ngram.length + 40));
            return { quote: slice.trim(), charOffset: found };
          }
        }
      }
    }
    // Number hunt e.g. 96%, 110%
    const nums = `${quote} ${fallbackPhrases.join(" ")}`.match(/\d+(?:\.\d+)?%?/g) ?? [];
    for (const num of nums) {
      if (num.length < 2) continue;
      // require nearby keyword context when possible
      const idx = t.text.indexOf(num);
      if (idx >= 0) {
        const start = Math.max(0, idx - 40);
        const slice = t.text.slice(start, idx + num.length + 40).replace(/\s+/g, " ").trim();
        return { quote: slice, charOffset: start };
      }
    }
    return { quote };
  }

  const commitments = portfolio.commitments.map((c) => {
    const t = pickTranscript(c.quarter, c.callDate, c.sourceUrl);
    const baseQuote = (c.quote || c.evidence || "").trim();
    const anchored = resolveAnchor(t, baseQuote, [c.commitment, c.evidence, baseQuote]);
    return {
      ...c,
      quote: anchored.quote || baseQuote,
      callDate: c.callDate ?? t?.callDate,
      sourceUrl: c.sourceUrl ?? t?.sourceUrl,
      charOffset: anchored.charOffset,
    };
  });

  let insights =
    portfolio.insights?.length > 0
      ? portfolio.insights
      : buildInsightsFromCommitments(commitments, portfolio.redFlags);

  insights = insights.map((ins, i) => {
    const t = pickTranscript(ins.quarter, ins.callDate, ins.sourceUrl) ?? transcripts[0];
    const baseQuote = (ins.quote || ins.body || "").trim();
    const anchored = resolveAnchor(t, baseQuote, [ins.title, ins.body, baseQuote]);
    return {
      ...ins,
      id: ins.id || `i-${i}`,
      quote: anchored.quote || baseQuote,
      callDate: ins.callDate ?? t?.callDate,
      sourceUrl: ins.sourceUrl ?? t?.sourceUrl,
      charOffset: anchored.charOffset,
    };
  });

  return { ...portfolio, commitments, insights };
}

/** Normalize labels like "Q2 FY26" / "q2fy26" → "Q2FY26". */
export function normalizeQuarterKey(raw: string): string | null {
  const m = String(raw || "")
    .toUpperCase()
    .match(/Q([1-4])\s*FY\s*(\d{2})/);
  if (!m) return null;
  return `Q${m[1]}FY${m[2]}`;
}

export type CallScoreSeed = {
  quarter: string;
  callScore: number;
  summary?: string;
  positiveCount?: number;
  negativeCount?: number;
  riskCount?: number;
};

function clampScore(n: number): number {
  return Math.round(Math.min(10, Math.max(1, n)) * 10) / 10;
}

/**
 * Quarter adjustment from a commitment outcome (0–10 scale).
 * Open-but-on-track is near-neutral / slight credit — not a drag.
 */
function commitmentDelta(status: CommitmentStatus): number {
  switch (status) {
    case "Met":
      return 0.55;
    case "Partially Completed":
      return 0.2;
    case "Under Execution":
      return 0.08;
    case "Early Execution":
      return 0;
    case "Not Met":
      return -0.95;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function compareQuarterKeys(a: string, b: string): number {
  const pa = a.match(/Q([1-4])FY(\d{2})/);
  const pb = b.match(/Q([1-4])FY(\d{2})/);
  if (!pa || !pb) return a.localeCompare(b);
  const ya = Number(pa[2]);
  const yb = Number(pb[2]);
  if (ya !== yb) return ya - yb;
  return Number(pa[1]) - Number(pb[1]);
}

/**
 * Deterministic per-quarter scores from that call’s evidence.
 *
 * - One entry per normalized quarter (duplicate labels averaged — no UX inventing).
 * - Base = mean callScore for that quarter; adjust by insights, commitments, red flags.
 * - No artificial rank-spreading / de-collision.
 */
export function buildQuarterTimeline(input: {
  calls: CallScoreSeed[];
  commitments: Commitment[];
  insights?: Insight[];
  redFlags?: string[];
  llmNotes?: TimelineEntry[];
}): TimelineEntry[] {
  const noteByQ = new Map<string, string>();
  for (const n of input.llmNotes ?? []) {
    const q = normalizeQuarterKey(n.quarter);
    if (q && n.note && !noteByQ.has(q)) noteByQ.set(q, n.note);
  }

  const insightByQ = new Map<string, Insight[]>();
  for (const ins of input.insights ?? []) {
    const q = normalizeQuarterKey(ins.quarter);
    if (!q) continue;
    const list = insightByQ.get(q) ?? [];
    list.push(ins);
    insightByQ.set(q, list);
  }

  // Aggregate duplicate quarter seeds (e.g. two Q4FY26 calls) by averaging callScore.
  type Agg = {
    scores: number[];
    summary?: string;
    positiveCount: number;
    negativeCount: number;
    riskCount: number;
    hasCounts: boolean;
  };
  const callAgg = new Map<string, Agg>();
  for (const c of input.calls) {
    const q = normalizeQuarterKey(c.quarter);
    if (!q) continue;
    const prev = callAgg.get(q) ?? {
      scores: [],
      positiveCount: 0,
      negativeCount: 0,
      riskCount: 0,
      hasCounts: false,
    };
    if (Number.isFinite(c.callScore)) prev.scores.push(Number(c.callScore));
    if (c.summary && !prev.summary) prev.summary = c.summary;
    if (
      c.positiveCount != null ||
      c.negativeCount != null ||
      c.riskCount != null
    ) {
      prev.hasCounts = true;
      prev.positiveCount += c.positiveCount ?? 0;
      prev.negativeCount += c.negativeCount ?? 0;
      prev.riskCount += c.riskCount ?? 0;
    }
    callAgg.set(q, prev);
  }

  const quarters = new Set<string>([
    ...callAgg.keys(),
    ...insightByQ.keys(),
    ...noteByQ.keys(),
  ]);
  for (const c of input.commitments) {
    const q = normalizeQuarterKey(c.quarter);
    if (q) quarters.add(q);
  }
  if (!quarters.size) return [];

  const redFlags = input.redFlags ?? [];
  const rows: TimelineEntry[] = [];

  for (const q of quarters) {
    const agg = callAgg.get(q);
    const insights = insightByQ.get(q) ?? [];
    const positives =
      agg?.hasCounts
        ? agg.positiveCount
        : insights.filter((i) => i.kind === "positive" || i.kind === "delivered").length;
    const negatives =
      agg?.hasCounts
        ? agg.negativeCount
        : insights.filter((i) => i.kind === "negative" || i.kind === "missed").length;
    const risks =
      agg?.hasCounts
        ? agg.riskCount
        : insights.filter((i) => i.kind === "risk").length;

    let score =
      agg && agg.scores.length > 0 ? mean(agg.scores) : 6.0;

    // Insight tone (cap so one loud call can't dominate)
    score += Math.min(3, positives) * 0.25;
    score -= Math.min(3, negatives) * 0.3;
    score -= Math.min(2, risks) * 0.4;

    // Commitments made in this quarter (promise quality / later delivery)
    for (const c of input.commitments) {
      const cq = normalizeQuarterKey(c.quarter);
      if (cq === q) score += commitmentDelta(c.status);
      else if (
        normalizeQuarterKey(c.evidence) === q ||
        c.evidence.toUpperCase().includes(q)
      ) {
        // Evidence landed in this quarter — lighter echo of outcome
        score += commitmentDelta(c.status) * 0.35;
      }
    }

    // Red flags that name this quarter
    let flagHits = 0;
    for (const flag of redFlags) {
      if (flag.toUpperCase().includes(q) || normalizeQuarterKey(flag) === q) {
        flagHits += 1;
      }
    }
    score -= Math.min(2, flagHits) * 0.85;

    const note =
      noteByQ.get(q) ||
      agg?.summary?.slice(0, 140) ||
      insights[0]?.title ||
      `${q} management signal`;

    rows.push({ quarter: q, score: clampScore(score), note });
  }

  rows.sort((a, b) => compareQuarterKeys(a.quarter, b.quarter));
  return rows;
}

/** Collapse duplicate quarter labels by averaging scores; keep first note. */
export function dedupeTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  const map = new Map<string, { scores: number[]; note: string }>();
  for (const t of entries) {
    const q = normalizeQuarterKey(t.quarter);
    if (!q) continue;
    const score = Number(t.score);
    if (!Number.isFinite(score)) continue;
    const prev = map.get(q);
    if (!prev) map.set(q, { scores: [score], note: t.note || "" });
    else {
      prev.scores.push(score);
      if (!prev.note && t.note) prev.note = t.note;
    }
  }
  const out: TimelineEntry[] = [...map.entries()].map(([quarter, v]) => ({
    quarter,
    score: clampScore(mean(v.scores)),
    note: v.note || `${quarter} management signal`,
  }));
  out.sort((a, b) => compareQuarterKeys(a.quarter, b.quarter));
  return out;
}

/**
 * Rebuild headline (and optionally timeline) from stored evidence. No LLM.
 *
 * - With `callSeeds` (raw per-call scores): full deterministic timeline rebuild.
 * - Without seeds: dedupe existing timeline only (do not re-apply adjustments onto
 *   already-adjusted scores), then refresh headline so labels stay coherent.
 */
export function recomputePortfolioScores(
  portfolio: PortfolioJson,
  callSeeds?: CallScoreSeed[]
): PortfolioJson {
  const priorTl = portfolio.timeline ?? [];

  const timeline =
    callSeeds && callSeeds.length > 0
      ? buildQuarterTimeline({
          calls: callSeeds,
          commitments: portfolio.commitments ?? [],
          insights: portfolio.insights ?? [],
          redFlags: portfolio.redFlags ?? [],
          llmNotes: priorTl,
        })
      : dedupeTimeline(priorTl);

  const { healthScore, label } = scoreHeadline({
    commitments: portfolio.commitments ?? [],
    insights: portfolio.insights ?? [],
    timeline,
    redFlags: portfolio.redFlags ?? [],
  });

  return {
    ...portfolio,
    timeline,
    healthScore,
    label,
  };
}

/**
 * Legacy name — recomputes headline + dedupes timeline (no double-adjustment).
 * Prefer recomputePortfolioScores; pass callSeeds when raw extracts are available.
 */
export function repairFlatTimeline(portfolio: PortfolioJson): PortfolioJson {
  return recomputePortfolioScores(portfolio);
}
