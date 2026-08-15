/** Map a release / call month to Indian FY quarter label (results quarter). */
export function indianFyQuarterFromDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1-12
  // Calendar Jan–Mar → Q4 of FY ending that year
  // Apr–Jun → Q1 FY (y+1)
  // Jul–Sep → Q2 FY (y+1)
  // Oct–Dec → Q3 FY (y+1)
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
