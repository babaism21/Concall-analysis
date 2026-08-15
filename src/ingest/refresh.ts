import { ingestSymbol, loadParsedTranscripts } from "./run.ts";
import { syncSymbolToPostgres } from "../db/sync.ts";
import type { TranscriptPayload } from "../types.ts";

export type RefreshResult = {
  symbol: string;
  discovered: number;
  parsed: number;
  latestSourceUrl: string | null;
  transcriptCount: number;
  transcripts: TranscriptPayload[];
  synced: boolean;
};

/**
 * PDF ingest only — no LLM. Syncs symbol to Postgres after ingest.
 */
export async function refreshSymbol(
  symbol: string,
  opts: { forceReparse?: boolean } = {}
): Promise<RefreshResult> {
  const sym = symbol.trim().toUpperCase();
  console.log(`[refresh] start ${sym} forceReparse=${Boolean(opts.forceReparse)}`);

  const ingest = await ingestSymbol(sym, undefined, { forceReparse: Boolean(opts.forceReparse) });
  const rows = loadParsedTranscripts(sym);
  const transcripts: TranscriptPayload[] = rows.map((t) => ({
    callDate: t.callDate,
    fyQuarter: t.fyQuarter,
    sourceUrl: t.sourceUrl,
    text: t.text,
    charCount: t.charCount,
  }));

  let synced = false;
  try {
    await syncSymbolToPostgres(sym);
    synced = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[refresh] Postgres sync failed for ${sym}: ${msg}`);
  }

  console.log(`[refresh] done ${sym} parsed=${transcripts.length} synced=${synced}`);
  return {
    symbol: sym,
    discovered: ingest.discovered,
    parsed: ingest.parsed,
    latestSourceUrl: transcripts[0]?.sourceUrl ?? ingest.latestSourceUrl,
    transcriptCount: transcripts.length,
    transcripts,
    synced,
  };
}
