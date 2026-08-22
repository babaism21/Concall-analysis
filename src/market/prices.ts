/**
 * Announcement-day prices for NSE stocks via Yahoo Finance (SYMBOL.NS).
 * Used to sit next to per-quarter management health scores.
 *
 * Semantics:
 * - `close` = close on the call / filing date (or nearest prior trading day)
 * - `dayChangePct` = that day's close vs previous session close
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";

export type DayPrice = {
  date: string; // YYYY-MM-DD trading day used
  close: number;
  prevClose: number | null;
  dayChangePct: number | null;
};

export type QuarterPrice = {
  quarter: string;
  callDate: string;
  price: DayPrice | null;
};

type CacheFile = {
  symbol: string;
  yahoo: string;
  fetchedAt: string;
  bars: Array<{ date: string; close: number }>;
};

const mem = new Map<string, CacheFile>();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function cachePath(symbol: string): string {
  const dir = join(DATA_DIR, "price-cache");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${symbol.toUpperCase()}.json`);
}

function loadCache(symbol: string): CacheFile | null {
  const key = symbol.toUpperCase();
  const hit = mem.get(key);
  if (hit && Date.now() - Date.parse(hit.fetchedAt) < CACHE_TTL_MS) return hit;
  const path = cachePath(key);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (Date.now() - Date.parse(parsed.fetchedAt) < CACHE_TTL_MS) {
      mem.set(key, parsed);
      return parsed;
    }
  } catch {
    /* ignore corrupt cache */
  }
  return null;
}

function saveCache(cache: CacheFile): void {
  mem.set(cache.symbol, cache);
  writeFileSync(cachePath(cache.symbol), JSON.stringify(cache));
}

function yahooSymbol(nseSymbol: string): string {
  const s = nseSymbol.trim().toUpperCase();
  if (s.endsWith(".NS") || s.endsWith(".BO")) return s;
  return `${s}.NS`;
}

function toUnix(isoDate: string): number {
  return Math.floor(Date.parse(isoDate + "T00:00:00Z") / 1000);
}

async function fetchYahooBars(
  symbol: string,
  fromIso: string,
  toIso: string
): Promise<Array<{ date: string; close: number }>> {
  const ysym = yahooSymbol(symbol);
  // pad range so we always have a prior close for the first call date
  const period1 = toUnix(fromIso) - 14 * 86400;
  const period2 = toUnix(toIso) + 3 * 86400;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}` +
    `?period1=${period1}&period2=${period2}&interval=1d&events=history`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ConcallAnalysis/0.1)",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    console.warn(`[prices] Yahoo ${ysym} HTTP ${res.status}`);
    return [];
  }
  const json = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: Array<number | null> }> };
      }>;
    };
  };
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const bars: Array<{ date: string; close: number }> = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    bars.push({ date, close: Math.round(c * 100) / 100 });
  }
  return bars;
}

async function barsForSymbol(
  symbol: string,
  dates: string[]
): Promise<Array<{ date: string; close: number }>> {
  if (!dates.length) return [];
  const cached = loadCache(symbol);
  const sorted = [...dates].sort();
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (cached?.bars?.length) {
    const haveMin = cached.bars[0]?.date;
    const haveMax = cached.bars[cached.bars.length - 1]?.date;
    if (haveMin && haveMax && haveMin <= min && haveMax >= max) return cached.bars;
  }
  try {
    const bars = await fetchYahooBars(symbol, min, max);
    if (bars.length) {
      saveCache({
        symbol: symbol.toUpperCase(),
        yahoo: yahooSymbol(symbol),
        fetchedAt: new Date().toISOString(),
        bars,
      });
    }
    return bars;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[prices] fetch failed ${symbol}: ${msg}`);
    return cached?.bars ?? [];
  }
}

function priceOnOrBefore(
  bars: Array<{ date: string; close: number }>,
  isoDate: string
): DayPrice | null {
  if (!bars.length) return null;
  let idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date <= isoDate) idx = i;
    else break;
  }
  if (idx < 0) return null;
  const close = bars[idx].close;
  const prevClose = idx > 0 ? bars[idx - 1].close : null;
  const dayChangePct =
    prevClose && prevClose > 0
      ? Math.round(((close - prevClose) / prevClose) * 1000) / 10
      : null;
  return { date: bars[idx].date, close, prevClose, dayChangePct };
}

/**
 * One price point per FY quarter, keyed off the newest callDate for that quarter.
 */
export async function pricesForQuarters(
  symbol: string,
  calls: Array<{ quarter: string; callDate: string }>
): Promise<QuarterPrice[]> {
  const byQ = new Map<string, string>();
  for (const c of calls) {
    const q = String(c.quarter || "").toUpperCase();
    const d = String(c.callDate || "").slice(0, 10);
    if (!q || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const prev = byQ.get(q);
    if (!prev || d > prev) byQ.set(q, d);
  }
  const dates = [...byQ.values()];
  const bars = await barsForSymbol(symbol, dates);
  return [...byQ.entries()].map(([quarter, callDate]) => ({
    quarter,
    callDate,
    price: priceOnOrBefore(bars, callDate),
  }));
}
