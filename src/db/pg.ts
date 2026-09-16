import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import pg from "pg";
import { BLOB_DIR, DATABASE_URL, USE_POSTGRES } from "../config.ts";
import { ensureDataDirs } from "../config.ts";
import type { PortfolioJson } from "../analyze/score.ts";
import { resultsQuarterFromCallDate, quarterRelabelMap, applyQuarterRelabel } from "../fy.ts";
import type { TranscriptPayload } from "../types.ts";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let schemaReady = false;

export type StockStatus = "ready" | "analysis_only" | "not_found";

export type PgAnalysis = {
  symbol: string;
  markdown: string;
  portfolioJson: PortfolioJson;
  latestSourceUrl: string | null;
  transcriptCount: number;
  modelId: string | null;
  promptVersion: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StockResponse = {
  symbol: string;
  status: StockStatus;
  analysis: PgAnalysis | null;
  transcripts: TranscriptPayload[];
};

export function isPostgresEnabled(): boolean {
  return USE_POSTGRES;
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    schemaReady = false;
  }
}

export async function initPgSchema(): Promise<void> {
  if (schemaReady) return;
  const client = getPool();
  await client.query(`
    CREATE TABLE IF NOT EXISTS filings (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      call_date TEXT NOT NULL,
      source_url TEXT NOT NULL UNIQUE,
      doc_type TEXT NOT NULL DEFAULT 'transcript',
      discovered_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_filings_symbol ON filings(symbol);

    CREATE TABLE IF NOT EXISTS transcripts (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      call_date TEXT NOT NULL,
      source_url TEXT NOT NULL UNIQUE,
      fy_quarter TEXT,
      pdf_sha256 TEXT,
      text_content TEXT,
      char_count INTEGER,
      parse_status TEXT NOT NULL DEFAULT 'pending',
      parsed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_transcripts_symbol ON transcripts(symbol);

    CREATE TABLE IF NOT EXISTS analyses (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      markdown TEXT NOT NULL,
      portfolio_json JSONB NOT NULL,
      latest_source_url TEXT,
      transcript_count INTEGER,
      model_id TEXT,
      prompt_version TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_symbol ON jobs(symbol);

    CREATE TABLE IF NOT EXISTS call_extracts (
      text_sha256 TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      symbol TEXT NOT NULL,
      call_date TEXT NOT NULL,
      fy_quarter TEXT,
      source_url TEXT NOT NULL,
      extract_json JSONB NOT NULL,
      model_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (text_sha256, prompt_version)
    );
    CREATE INDEX IF NOT EXISTS idx_call_extracts_symbol ON call_extracts(symbol);
  `);
  schemaReady = true;
}

export function sha256File(path: string): string {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

export function ensureBlobPdf(pdfPath: string | null | undefined): string | null {
  if (!pdfPath || !existsSync(pdfPath)) return null;
  ensureDataDirs();
  const sha = sha256File(pdfPath);
  const dest = `${BLOB_DIR}/${sha}.pdf`;
  if (!existsSync(dest)) {
    copyFileSync(pdfPath, dest);
    console.log(`[pg] blob stored ${sha}.pdf`);
  }
  return sha;
}

/** Symbols with cached management analysis (ready to open in the UI). */
export async function listAvailableSymbolsFromPg(): Promise<string[]> {
  await initPgSchema();
  const client = getPool();
  const res = await client.query(
    `SELECT symbol FROM analyses ORDER BY symbol ASC`
  );
  return res.rows.map((r) => String(r.symbol).toUpperCase());
}

export async function getStockFromPg(symbol: string): Promise<StockResponse> {
  const sym = symbol.trim().toUpperCase();
  await initPgSchema();
  const client = getPool();

  const analysisRes = await client.query(
    `SELECT symbol, markdown, portfolio_json, latest_source_url, transcript_count,
            model_id, prompt_version, created_at, updated_at
     FROM analyses WHERE symbol = $1`,
    [sym]
  );

  const txRes = await client.query(
    `SELECT call_date, fy_quarter, source_url, text_content, char_count
     FROM transcripts
     WHERE symbol = $1 AND parse_status = 'ok' AND text_content IS NOT NULL
     ORDER BY call_date DESC`,
    [sym]
  );

  const transcripts: TranscriptPayload[] = txRes.rows.map((r) => {
    const callDate = r.call_date as string;
    const corrected =
      resultsQuarterFromCallDate(callDate) || String(r.fy_quarter ?? "");
    return {
      callDate,
      fyQuarter: corrected,
      sourceUrl: r.source_url,
      text: r.text_content,
      charCount: Number(r.char_count ?? 0),
    };
  });

  if (!analysisRes.rows.length) {
    return {
      symbol: sym,
      status: "not_found",
      analysis: null,
      transcripts,
    };
  }

  const row = analysisRes.rows[0];
  const portfolioJson = row.portfolio_json as PortfolioJson;
  if (!portfolioJson.insights) portfolioJson.insights = [];
  // Fix legacy call-month→quarter mislabels (Jul call was wrongly Q2, etc.)
  {
    const qmap = quarterRelabelMap(
      txRes.rows.map((r) => ({
        callDate: r.call_date as string,
        fyQuarter: String(r.fy_quarter ?? ""),
      }))
    );
    if (qmap.size) {
      portfolioJson.timeline = (portfolioJson.timeline ?? []).map((e) => ({
        ...e,
        quarter: applyQuarterRelabel(e.quarter, qmap),
      }));
      portfolioJson.insights = (portfolioJson.insights ?? []).map((e) => ({
        ...e,
        quarter: applyQuarterRelabel(e.quarter, qmap),
      }));
      portfolioJson.commitments = (portfolioJson.commitments ?? []).map((e) => ({
        ...e,
        quarter: applyQuarterRelabel(e.quarter, qmap),
      }));
    }
  }

  const analysis: PgAnalysis = {
    symbol: row.symbol,
    markdown: row.markdown,
    portfolioJson,
    latestSourceUrl: row.latest_source_url,
    transcriptCount: Number(row.transcript_count ?? 0),
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };

  return {
    symbol: sym,
    status: transcripts.length ? "ready" : "analysis_only",
    analysis,
    transcripts,
  };
}

export async function upsertAnalysisToPg(
  rec: Omit<PgAnalysis, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }
): Promise<void> {
  await initPgSchema();
  const now = new Date().toISOString();
  await getPool().query(
    `INSERT INTO analyses (
       symbol, markdown, portfolio_json, latest_source_url, transcript_count,
       model_id, prompt_version, created_at, updated_at
     ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (symbol) DO UPDATE SET
       markdown = EXCLUDED.markdown,
       portfolio_json = EXCLUDED.portfolio_json,
       latest_source_url = EXCLUDED.latest_source_url,
       transcript_count = EXCLUDED.transcript_count,
       model_id = EXCLUDED.model_id,
       prompt_version = EXCLUDED.prompt_version,
       updated_at = EXCLUDED.updated_at`,
    [
      rec.symbol,
      rec.markdown,
      JSON.stringify(rec.portfolioJson),
      rec.latestSourceUrl,
      rec.transcriptCount,
      rec.modelId,
      rec.promptVersion,
      rec.createdAt ?? now,
      rec.updatedAt ?? now,
    ]
  );
}

export async function upsertTranscriptToPg(row: {
  symbol: string;
  callDate: string;
  sourceUrl: string;
  fyQuarter: string | null;
  pdfSha256: string | null;
  textContent: string | null;
  charCount: number;
  parseStatus: string;
  parsedAt: string | null;
}): Promise<void> {
  await initPgSchema();
  const now = new Date().toISOString();
  await getPool().query(
    `INSERT INTO transcripts (
       symbol, call_date, source_url, fy_quarter, pdf_sha256, text_content,
       char_count, parse_status, parsed_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (source_url) DO UPDATE SET
       symbol = EXCLUDED.symbol,
       call_date = EXCLUDED.call_date,
       fy_quarter = EXCLUDED.fy_quarter,
       pdf_sha256 = EXCLUDED.pdf_sha256,
       text_content = EXCLUDED.text_content,
       char_count = EXCLUDED.char_count,
       parse_status = EXCLUDED.parse_status,
       parsed_at = EXCLUDED.parsed_at,
       updated_at = EXCLUDED.updated_at`,
    [
      row.symbol,
      row.callDate,
      row.sourceUrl,
      row.fyQuarter,
      row.pdfSha256,
      row.textContent,
      row.charCount,
      row.parseStatus,
      row.parsedAt,
      now,
    ]
  );
}

export async function upsertFilingToPg(row: {
  symbol: string;
  callDate: string;
  sourceUrl: string;
  docType: string;
  discoveredAt: string;
}): Promise<void> {
  await initPgSchema();
  await getPool().query(
    `INSERT INTO filings (symbol, call_date, source_url, doc_type, discovered_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_url) DO UPDATE SET
       symbol = EXCLUDED.symbol,
       call_date = EXCLUDED.call_date,
       doc_type = EXCLUDED.doc_type,
       discovered_at = EXCLUDED.discovered_at`,
    [row.symbol, row.callDate, row.sourceUrl, row.docType, row.discoveredAt]
  );
}

export async function recordJob(
  symbol: string,
  jobType: string,
  status: string,
  errorMessage?: string
): Promise<void> {
  await initPgSchema();
  const now = new Date().toISOString();
  await getPool().query(
    `INSERT INTO jobs (symbol, job_type, status, error_message, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      symbol.trim().toUpperCase(),
      jobType,
      status,
      errorMessage ?? null,
      status === "running" ? now : null,
      status === "completed" || status === "failed" ? now : null,
    ]
  );
}

export async function pingPostgres(): Promise<boolean> {
  try {
    await initPgSchema();
    await getPool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
