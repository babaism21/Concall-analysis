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

const STATUS_WEIGHT: Record<string, number> = {
  Met: 100,
  "Partially Completed": 70,
  "Under Execution": 50,
  "Early Execution": 30,
  "Not Met": 0,
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

/** Deterministic headline score from commitment statuses. */
export function scoreFromCommitments(commitments: Commitment[]): {
  healthScore: number;
  label: PortfolioJson["label"];
} {
  if (!commitments.length) {
    return { healthScore: 0, label: "Weak" };
  }
  const weights = commitments.map((c) => STATUS_WEIGHT[c.status] ?? 0);
  const healthScore = Math.round(weights.reduce((a, b) => a + b, 0) / weights.length);
  const label: PortfolioJson["label"] =
    healthScore >= 75 ? "Good" : healthScore >= 50 ? "Average" : "Weak";
  return { healthScore, label };
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

function commitmentDelta(status: CommitmentStatus): number {
  switch (status) {
    case "Met":
      return 0.9;
    case "Partially Completed":
      return 0.25;
    case "Under Execution":
      return -0.15;
    case "Early Execution":
      return -0.25;
    case "Not Met":
      return -1.1;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/**
 * Deterministic per-quarter scores (NiftyGPT-style).
 * Base = per-call callScore, then adjust for insight mix, commitment outcomes,
 * and red flags. Spreads colliding scores so the UI never shows a flat 80/80/80.
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
    if (q && n.note) noteByQ.set(q, n.note);
  }

  const insightByQ = new Map<string, Insight[]>();
  for (const ins of input.insights ?? []) {
    const q = normalizeQuarterKey(ins.quarter);
    if (!q) continue;
    const list = insightByQ.get(q) ?? [];
    list.push(ins);
    insightByQ.set(q, list);
  }

  const callByQ = new Map<string, CallScoreSeed>();
  for (const c of input.calls) {
    const q = normalizeQuarterKey(c.quarter);
    if (!q) continue;
    callByQ.set(q, { ...c, quarter: q });
  }

  // Ensure every quarter that appears in commitments/insights/notes is scored
  const quarters = new Set<string>([
    ...callByQ.keys(),
    ...insightByQ.keys(),
    ...noteByQ.keys(),
  ]);
  for (const c of input.commitments) {
    const q = normalizeQuarterKey(c.quarter);
    if (q) quarters.add(q);
  }
  if (!quarters.size) return [];

  const redFlags = input.redFlags ?? [];

  type Row = { quarter: string; raw: number; note: string };
  const rows: Row[] = [];

  for (const q of quarters) {
    const call = callByQ.get(q);
    const insights = insightByQ.get(q) ?? [];
    const positives =
      call?.positiveCount ??
      insights.filter((i) => i.kind === "positive" || i.kind === "delivered").length;
    const negatives =
      call?.negativeCount ??
      insights.filter((i) => i.kind === "negative" || i.kind === "missed").length;
    const risks =
      call?.riskCount ?? insights.filter((i) => i.kind === "risk").length;

    let score = Number.isFinite(call?.callScore) ? Number(call!.callScore) : 6.5;

    // Insight tone (cap so one loud call can't dominate)
    score += Math.min(3, positives) * 0.3;
    score -= Math.min(3, negatives) * 0.35;
    score -= Math.min(2, risks) * 0.45;

    // Commitments made in this quarter (promise quality / later delivery)
    for (const c of input.commitments) {
      const cq = normalizeQuarterKey(c.quarter);
      if (cq === q) score += commitmentDelta(c.status);
      else if (normalizeQuarterKey(c.evidence) === q || c.evidence.toUpperCase().includes(q)) {
        // Evidence landed in this quarter — lighter echo of outcome
        score += commitmentDelta(c.status) * 0.35;
      }
    }

    // Red flags that name this quarter
    let flagHits = 0;
    for (const flag of redFlags) {
      if (flag.toUpperCase().includes(q) || (normalizeQuarterKey(flag) === q)) {
        flagHits += 1;
      }
    }
    score -= Math.min(2, flagHits) * 0.9;

    const note =
      noteByQ.get(q) ||
      call?.summary?.slice(0, 140) ||
      insights[0]?.title ||
      `${q} management signal`;

    rows.push({ quarter: q, raw: score, note });
  }

  // Chronological-ish: FY then quarter
  rows.sort((a, b) => {
    const pa = a.quarter.match(/Q([1-4])FY(\d{2})/);
    const pb = b.quarter.match(/Q([1-4])FY(\d{2})/);
    if (!pa || !pb) return a.quarter.localeCompare(b.quarter);
    const ya = Number(pa[2]);
    const yb = Number(pb[2]);
    if (ya !== yb) return ya - yb;
    return Number(pa[1]) - Number(pb[1]);
  });

  // Spread collisions so chips are unique for users (NiftyGPT timeline feel)
  const ranked = [...rows].sort((a, b) => a.raw - b.raw);
  const rankBoost = new Map<string, number>();
  ranked.forEach((r, i) => {
    // center around 0; step 0.15 across the set
    const mid = (ranked.length - 1) / 2;
    rankBoost.set(r.quarter, (i - mid) * 0.1);
  });

  const out = rows.map((r) => ({
    quarter: r.quarter,
    score: clampScore(r.raw + (rankBoost.get(r.quarter) ?? 0)),
    note: r.note,
  }));

  // Final uniqueness pass: if two still collide after rounding, nudge later ones
  const seen = new Map<number, number>();
  for (const entry of out) {
    let s = entry.score;
    let guard = 0;
    while (seen.has(s) && guard < 20) {
      s = clampScore(s + 0.2);
      guard += 1;
    }
    seen.set(s, 1);
    entry.score = s;
  }

  return out;
}

/** Rebuild flat LLM timelines from commitments + insights (no re-analyze needed). */
export function repairFlatTimeline(portfolio: PortfolioJson): PortfolioJson {
  const tl = portfolio.timeline ?? [];
  const scores = tl.map((t) => Number(t.score)).filter((n) => Number.isFinite(n));
  const spread =
    scores.length >= 2 ? Math.max(...scores) - Math.min(...scores) : Number.POSITIVE_INFINITY;
  // Also catch "almost all 8s with one outlier" — common LLM failure mode
  let modeShare = 0;
  if (scores.length) {
    const counts = new Map<number, number>();
    for (const s of scores) counts.set(s, (counts.get(s) ?? 0) + 1);
    modeShare = Math.max(...counts.values()) / scores.length;
  }
  const needsRepair =
    tl.length === 0 ||
    (scores.length >= 2 && spread < 0.75) ||
    (scores.length >= 4 && modeShare >= 0.6);
  if (!needsRepair) return portfolio;

  const quarters = new Set<string>();
  for (const t of tl) {
    const q = normalizeQuarterKey(t.quarter);
    if (q) quarters.add(q);
  }
  for (const c of portfolio.commitments ?? []) {
    const q = normalizeQuarterKey(c.quarter);
    if (q) quarters.add(q);
  }
  for (const i of portfolio.insights ?? []) {
    const q = normalizeQuarterKey(i.quarter);
    if (q) quarters.add(q);
  }

  const calls: CallScoreSeed[] = [...quarters].map((q) => {
    const prior = tl.find((t) => normalizeQuarterKey(t.quarter) === q);
    const base = prior && Number.isFinite(prior.score) ? Number(prior.score) : 6.5;
    return { quarter: q, callScore: base, summary: prior?.note };
  });

  const timeline = buildQuarterTimeline({
    calls,
    commitments: portfolio.commitments ?? [],
    insights: portfolio.insights ?? [],
    redFlags: portfolio.redFlags ?? [],
    llmNotes: tl,
  });

  return { ...portfolio, timeline };
}
