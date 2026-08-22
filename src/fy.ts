/**
 * Indian financial year runs Apr → Mar.
 *   Q1FYxx = Apr–Jun (of calendar year xx-1)
 *   Q2FYxx = Jul–Sep
 *   Q3FYxx = Oct–Dec
 *   Q4FYxx = Jan–Mar (of calendar year xx)
 *
 * Screener / BSE dates on concalls are the *call / filing month*, which is
 * AFTER the quarter ends — e.g. a Jul 2026 transcript discusses Q1FY27
 * (Apr–Jun 2026), not Q2. So we map call month → results quarter with a lag.
 */

/** Results quarter for an earnings-call / transcript release date. */
export function indianFyQuarterFromDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1–12

  // Call in Jan–Mar → Q3 of FY ending this calendar year (Oct–Dec just reported)
  if (m <= 3) return `Q3FY${String(y).slice(2)}`;

  // Call in Apr–Jun → Q4 of FY that ended in March of this year
  if (m <= 6) return `Q4FY${String(y).slice(2)}`;

  // Call in Jul–Sep → Q1 of FY ending next March
  if (m <= 9) return `Q1FY${String(y + 1).slice(2)}`;

  // Call in Oct–Dec → Q2 of FY ending next March
  return `Q2FY${String(y + 1).slice(2)}`;
}

/**
 * @deprecated Wrong mapping that treated call month as inside the results quarter.
 * Kept only to remap already-stored labels.
 */
export function indianFyQuarterFromDateLegacyWrong(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (m <= 3) return `Q4FY${String(y).slice(2)}`;
  const fy = y + 1;
  if (m <= 6) return `Q1FY${String(fy).slice(2)}`;
  if (m <= 9) return `Q2FY${String(fy).slice(2)}`;
  return `Q3FY${String(fy).slice(2)}`;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

/** Parse Screener-style "Jul 2026" → ISO date (first of month UTC). */
export function parseMonthYear(label: string): { isoDate: string; date: Date } | null {
  const m = label.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  const year = Number(m[2]);
  const date = new Date(Date.UTC(year, month, 1));
  const isoDate = date.toISOString().slice(0, 10);
  return { isoDate, date };
}


/** Recompute results-quarter label from a call/filing ISO date (YYYY-MM-DD). */
export function resultsQuarterFromCallDate(callDate: string): string | null {
  const d = new Date(callDate.includes("T") ? callDate : callDate + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return indianFyQuarterFromDate(d);
}

/**
 * Build old→new quarter map for transcripts labeled with the legacy (wrong) scheme.
 * Used to rewrite portfolio timeline / insights without a full re-analyze.
 */
export function quarterRelabelMap(
  transcripts: Array<{ callDate: string; fyQuarter?: string }>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of transcripts) {
    const next = resultsQuarterFromCallDate(t.callDate);
    if (!next) continue;
    const prev = (t.fyQuarter || "").toUpperCase();
    if (prev) map.set(prev, next);
    // Also map what the legacy function would have produced for this call date
    const d = new Date(t.callDate.includes("T") ? t.callDate : t.callDate + "T00:00:00Z");
    if (!Number.isNaN(d.getTime())) {
      map.set(indianFyQuarterFromDateLegacyWrong(d).toUpperCase(), next);
    }
  }
  return map;
}

export function applyQuarterRelabel(label: string, map: Map<string, string>): string {
  const m = String(label || "").match(/Q[1-4]FY\d{2}/i)?.[0]?.toUpperCase();
  if (!m) return label;
  return map.get(m) ?? label;
}
