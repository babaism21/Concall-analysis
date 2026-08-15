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
  kind: "delivered" | "missed" | "open" | "risk" | "guidance";
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

  const pickTranscript = (quarterLabel: string): TranscriptRef | undefined => {
    const q = quarterLabel.match(/Q[1-4]FY\d{2}/i)?.[0]?.toUpperCase();
    if (q && byQuarter.has(q)) return byQuarter.get(q)![0];
    // fallback: newest
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
    const t = pickTranscript(c.quarter);
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
    const t = pickTranscript(ins.quarter) ?? transcripts[0];
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
