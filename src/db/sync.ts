import { getDb } from "../db.ts";
import {
  ensureBlobPdf,
  isPostgresEnabled,
  recordJob,
  upsertAnalysisToPg,
  upsertFilingToPg,
  upsertTranscriptToPg,
} from "./pg.ts";

export async function syncSymbolToPostgres(symbol: string): Promise<{
  filings: number;
  transcripts: number;
  analysis: boolean;
}> {
  if (!isPostgresEnabled()) {
    return { filings: 0, transcripts: 0, analysis: false };
  }

  const sym = symbol.trim().toUpperCase();
  const db = getDb();
  let filingCount = 0;
  let transcriptCount = 0;
  let hasAnalysis = false;

  try {
    await recordJob(sym, "sync", "running");

    const filings = db
      .prepare(
        `SELECT symbol, call_date as callDate, source_url as sourceUrl,
                doc_type as docType, discovered_at as discoveredAt
         FROM conference_call_urls WHERE symbol = ?`
      )
      .all(sym) as Array<{
      symbol: string;
      callDate: string;
      sourceUrl: string;
      docType: string;
      discoveredAt: string;
    }>;

    for (const f of filings) {
      await upsertFilingToPg({
        symbol: f.symbol,
        callDate: f.callDate,
        sourceUrl: f.sourceUrl,
        docType: f.docType,
        discoveredAt: f.discoveredAt,
      });
      filingCount++;
    }

    const transcripts = db
      .prepare(
        `SELECT symbol, call_date as callDate, source_url as sourceUrl,
                fy_quarter as fyQuarter, pdf_path as pdfPath, text_content as textContent,
                char_count as charCount, parse_status as parseStatus, parsed_at as parsedAt
         FROM parsed_conference_content WHERE symbol = ?`
      )
      .all(sym) as Array<{
      symbol: string;
      callDate: string;
      sourceUrl: string;
      fyQuarter: string | null;
      pdfPath: string | null;
      textContent: string | null;
      charCount: number;
      parseStatus: string;
      parsedAt: string | null;
    }>;

    for (const t of transcripts) {
      const pdfSha256 = ensureBlobPdf(t.pdfPath);
      await upsertTranscriptToPg({
        symbol: t.symbol,
        callDate: t.callDate,
        sourceUrl: t.sourceUrl,
        fyQuarter: t.fyQuarter,
        pdfSha256,
        textContent: t.textContent,
        charCount: t.charCount ?? 0,
        parseStatus: t.parseStatus,
        parsedAt: t.parsedAt,
      });
      if (t.parseStatus === "ok" && t.textContent) transcriptCount++;
    }

    const analysis = db
      .prepare(
        `SELECT symbol, markdown, portfolio_json as portfolioJson, latest_source_url as latestSourceUrl,
                transcript_count as transcriptCount, model_id as modelId, prompt_version as promptVersion,
                created_at as createdAt, updated_at as updatedAt
         FROM management_analysis WHERE symbol = ?`
      )
      .get(sym) as
      | {
          symbol: string;
          markdown: string;
          portfolioJson: string;
          latestSourceUrl: string | null;
          transcriptCount: number;
          modelId: string | null;
          promptVersion: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    if (analysis) {
      await upsertAnalysisToPg({
        symbol: analysis.symbol,
        markdown: analysis.markdown,
        portfolioJson: JSON.parse(analysis.portfolioJson),
        latestSourceUrl: analysis.latestSourceUrl,
        transcriptCount: analysis.transcriptCount,
        modelId: analysis.modelId,
        promptVersion: analysis.promptVersion,
        createdAt: analysis.createdAt,
        updatedAt: analysis.updatedAt,
      });
      hasAnalysis = true;
    }

    await recordJob(sym, "sync", "completed");
    console.log(
      `[sync] ${sym} → Postgres (${filingCount} filings, ${transcriptCount} transcripts, analysis=${hasAnalysis})`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordJob(sym, "sync", "failed", msg);
    throw err;
  }

  return { filings: filingCount, transcripts: transcriptCount, analysis: hasAnalysis };
}

export async function syncAllSymbolsToPostgres(): Promise<void> {
  const db = getDb();
  const symbols = db
    .prepare(
      `SELECT DISTINCT symbol FROM (
         SELECT symbol FROM conference_call_urls
         UNION SELECT symbol FROM parsed_conference_content
         UNION SELECT symbol FROM management_analysis
       )`
    )
    .all() as Array<{ symbol: string }>;

  console.log(`[migrate] syncing ${symbols.length} symbols to Postgres`);
  for (const { symbol } of symbols) {
    await syncSymbolToPostgres(symbol);
  }
}
