import { USER_AGENT } from "../config.ts";
import { parseMonthYear } from "../fy.ts";

export type DiscoveredConcall = {
  symbol: string;
  callDate: string; // YYYY-MM-DD
  sourceUrl: string;
  label: string; // e.g. Jul 2026
};

function normalizeUrl(url: string): string {
  // Prefer direct AttachHis when AnnPdfOpen wraps a uuid.pdf
  const m = url.match(/AnnPdfOpen\.aspx\?Pname=([0-9a-f-]+\.pdf)/i);
  if (m) {
    return `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${m[1]}`;
  }
  return url.replace(/^http:\/\//i, "https://");
}

function isTranscriptCandidate(url: string): boolean {
  const u = url.toLowerCase();
  if (u.includes("annualreport") || u.includes("annual-report")) return false;
  if (u.includes("careratings.com")) return false;
  // Prefer BSE filing PDFs; allow company IR host as rare fallback
  return (
    u.includes("bseindia.com") ||
    u.includes("nsearchives.nseindia.com") ||
    u.includes("nseindia.com")
  );
}

/**
 * Primary discovery: Screener company page HTML → Raw Transcript links.
 * Firecrawl is intentionally not used here.
 */
export async function collectConcallUrls(symbol: string): Promise<DiscoveredConcall[]> {
  const sym = symbol.trim().toUpperCase();
  const url = `https://www.screener.in/company/${encodeURIComponent(sym)}/`;
  console.log(`[ingest] fetch Screener ${url}`);

  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) {
    throw new Error(`Screener fetch failed ${res.status} for ${sym}`);
  }
  const html = await res.text();

  const found: DiscoveredConcall[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(
    /href="(https?:\/\/[^"]+)"[^>]*title="Raw Transcript"/gi
  )) {
    const rawUrl = match[1];
    if (!isTranscriptCandidate(rawUrl)) continue;
    const sourceUrl = normalizeUrl(rawUrl);
    if (seen.has(sourceUrl)) continue;

    const lookback = html.slice(Math.max(0, match.index! - 900), match.index!);
    const dates = [...lookback.matchAll(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/gi)];
    const label = dates.length ? dates[dates.length - 1][1] : "";
    const parsed = label ? parseMonthYear(label) : null;
    if (!parsed) continue;

    seen.add(sourceUrl);
    found.push({
      symbol: sym,
      callDate: parsed.isoDate,
      sourceUrl,
      label,
    });
  }

  found.sort((a, b) => b.callDate.localeCompare(a.callDate));
  console.log(`[ingest] discovered ${found.length} transcript URLs for ${sym}`);
  return found;
}
