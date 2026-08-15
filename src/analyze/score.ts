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
};

export type TimelineEntry = {
  quarter: string;
  score: number;
  note: string;
};

export type PortfolioJson = {
  symbol: string;
  healthScore: number; // 0-100 deterministic
  label: "Good" | "Average" | "Weak";
  rawScore: number | null; // LLM 0-10
  redFlags: string[];
  commitments: Commitment[];
  timeline: TimelineEntry[];
  summary: string;
  transcriptCount: number;
  latestSourceUrl: string | null;
  scoredAt: string;
};

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
