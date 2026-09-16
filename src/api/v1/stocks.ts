import {
  getStockFromPg,
  isPostgresEnabled,
  listAvailableSymbolsFromPg,
} from "../../db/pg.ts";
import { stockToUiPayload } from "../../db/read.ts";
import { getDb } from "../../db.ts";

export async function getStock(symbol: string) {
  if (!isPostgresEnabled()) {
    return {
      symbol: symbol.trim().toUpperCase(),
      status: "not_found" as const,
      analysis: null,
      transcripts: [],
    };
  }
  return getStockFromPg(symbol);
}

/** Symbols with analysis ready to open in the UI. */
export async function listAvailableStocks(): Promise<string[]> {
  if (isPostgresEnabled()) {
    return listAvailableSymbolsFromPg();
  }
  const rows = getDb()
    .prepare(`SELECT symbol FROM management_analysis ORDER BY symbol ASC`)
    .all() as Array<{ symbol: string }>;
  return rows.map((r) => String(r.symbol).toUpperCase());
}

export { stockToUiPayload };
