import { getStockFromPg, isPostgresEnabled } from "../../db/pg.ts";
import { stockToUiPayload } from "../../db/read.ts";

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

export { stockToUiPayload };
