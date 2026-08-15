import { MAX_TRANSCRIPTS } from "../config.ts";
import { getDb, nowIso } from "../db.ts";
import { indianFyQuarterFromDate } from "../fy.ts";
import { collectConcallUrls } from "./screener.ts";
import { downloadPdf } from "./download.ts";
import { parsePdfToText } from "./parse.ts";

export type IngestResult = {
  symbol: string;
  discovered: number;
  parsed: number;
  latestSourceUrl: string | null;
  transcripts: Array<{
    callDate: string;
    fyQuarter: string;
    sourceUrl: string;
    charCount: number;
  }>;
};

export async function ingestSymbol(
  symbol: string,
  limit = MAX_TRANSCRIPTS
): Promise<IngestResult> {
  const sym = symbol.trim().toUpperCase();
  const db = getDb();
  const urls = await collectConcallUrls(sym);
  const top = urls.slice(0, limit);
  const ts = nowIso();

  const upsertUrl = db.prepare(`
    INSERT INTO conference_call_urls (symbol, call_date, source_url, doc_type, discovered_at)
    VALUES (?, ?, ?, 'transcript', ?)
    ON CONFLICT(symbol, source_url) DO UPDATE SET
      call_date = excluded.call_date,
      discovered_at = excluded.discovered_at
  `);

  const upsertContent = db.prepare(`
    INSERT INTO parsed_conference_content (
      symbol, call_date, source_url, fy_quarter, pdf_path, text_content,
      char_count, parse_status, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, source_url) DO UPDATE SET
      call_date = excluded.call_date,
      fy_quarter = excluded.fy_quarter,
      pdf_path = excluded.pdf_path,
      text_content = excluded.text_content,
      char_count = excluded.char_count,
      parse_status = excluded.parse_status,
      parsed_at = excluded.parsed_at
  `);

  const transcripts: IngestResult["transcripts"] = [];

  const existingOk = db.prepare(
    `SELECT source_url FROM parsed_conference_content
     WHERE symbol = ? AND source_url = ? AND parse_status = 'ok' AND text_content IS NOT NULL`
  );

  for (const item of top) {
    upsertUrl.run(sym, item.callDate, item.sourceUrl, ts);
    try {
      if (existingOk.get(sym, item.sourceUrl)) {
        const row = db
          .prepare(
            `SELECT call_date as callDate, fy_quarter as fyQuarter, source_url as sourceUrl, char_count as charCount
             FROM parsed_conference_content WHERE symbol = ? AND source_url = ?`
          )
          .get(sym, item.sourceUrl) as {
          callDate: string;
          fyQuarter: string;
          sourceUrl: string;
          charCount: number;
        };
        transcripts.push(row);
        console.log(`[ingest] parse cache hit ${row.fyQuarter} ${row.callDate}`);
        continue;
      }
      const pdfPath = await downloadPdf(sym, item.callDate, item.sourceUrl);
      const { text, charCount } = await parsePdfToText(pdfPath);
      if (charCount < 500) {
        console.log(`[ingest] skip thin text (${charCount} chars) ${item.sourceUrl}`);
        upsertContent.run(
          sym,
          item.callDate,
          item.sourceUrl,
          indianFyQuarterFromDate(new Date(item.callDate + "T00:00:00Z")),
          pdfPath,
          text,
          charCount,
          "thin",
          ts
        );
        continue;
      }
      const fy = indianFyQuarterFromDate(new Date(item.callDate + "T00:00:00Z"));
      upsertContent.run(
        sym,
        item.callDate,
        item.sourceUrl,
        fy,
        pdfPath,
        text,
        charCount,
        "ok",
        ts
      );
      transcripts.push({
        callDate: item.callDate,
        fyQuarter: fy,
        sourceUrl: item.sourceUrl,
        charCount,
      });
      console.log(`[ingest] parsed ${fy} ${item.callDate} (${charCount} chars)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] failed ${item.sourceUrl}: ${msg}`);
      upsertContent.run(
        sym,
        item.callDate,
        item.sourceUrl,
        indianFyQuarterFromDate(new Date(item.callDate + "T00:00:00Z")),
        null,
        null,
        0,
        "error",
        ts
      );
    }
  }

  return {
    symbol: sym,
    discovered: urls.length,
    parsed: transcripts.length,
    latestSourceUrl: transcripts[0]?.sourceUrl ?? top[0]?.sourceUrl ?? null,
    transcripts,
  };
}

export function loadParsedTranscripts(symbol: string, limit = MAX_TRANSCRIPTS) {
  const db = getDb();
  const sym = symbol.trim().toUpperCase();
  return db
    .prepare(
      `SELECT call_date as callDate, fy_quarter as fyQuarter, source_url as sourceUrl,
              text_content as text, char_count as charCount
       FROM parsed_conference_content
       WHERE symbol = ? AND parse_status = 'ok' AND text_content IS NOT NULL
       ORDER BY call_date DESC
       LIMIT ?`
    )
    .all(sym, limit) as Array<{
    callDate: string;
    fyQuarter: string;
    sourceUrl: string;
    text: string;
    charCount: number;
  }>;
}
