import { createHash } from "node:crypto";
import { getDb, nowIso } from "../db.ts";
import { MODEL_ID, PROMPT_VERSION } from "../config.ts";
import { getPool, initPgSchema, isPostgresEnabled } from "./pg.ts";
import type { Insight } from "../analyze/score.ts";

/** Stored per-transcript extract (keyed by text hash). */
export type CachedCallExtract = {
  fyQuarter: string;
  callDate: string;
  sourceUrl: string;
  callScore: number;
  summary: string;
  insights: Insight[];
  guidance: Array<{ title: string; body: string }>;
  negative: Array<{ title: string; body: string }>;
};

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function getCachedExtract(
  textSha256: string,
  promptVersion = PROMPT_VERSION
): CachedCallExtract | null {
  const row = getDb()
    .prepare(
      `SELECT extract_json as extractJson FROM call_extracts
       WHERE text_sha256 = ? AND prompt_version = ?`
    )
    .get(textSha256, promptVersion) as { extractJson: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.extractJson) as CachedCallExtract;
  } catch {
    return null;
  }
}

export function saveCallExtract(opts: {
  textSha256: string;
  symbol: string;
  callDate: string;
  fyQuarter: string;
  sourceUrl: string;
  extract: CachedCallExtract;
  promptVersion?: string;
  modelId?: string;
}): void {
  const promptVersion = opts.promptVersion ?? PROMPT_VERSION;
  const modelId = opts.modelId ?? MODEL_ID;
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO call_extracts (
         text_sha256, prompt_version, symbol, call_date, fy_quarter, source_url,
         extract_json, model_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(text_sha256, prompt_version) DO UPDATE SET
         symbol = excluded.symbol,
         call_date = excluded.call_date,
         fy_quarter = excluded.fy_quarter,
         source_url = excluded.source_url,
         extract_json = excluded.extract_json,
         model_id = excluded.model_id`
    )
    .run(
      opts.textSha256,
      promptVersion,
      opts.symbol,
      opts.callDate,
      opts.fyQuarter,
      opts.sourceUrl,
      JSON.stringify(opts.extract),
      modelId,
      ts
    );

  if (isPostgresEnabled()) {
    void upsertExtractToPg({
      textSha256: opts.textSha256,
      promptVersion,
      symbol: opts.symbol,
      callDate: opts.callDate,
      fyQuarter: opts.fyQuarter,
      sourceUrl: opts.sourceUrl,
      extract: opts.extract,
      modelId,
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[extract-cache] Postgres upsert failed: ${msg}`);
    });
  }
}

async function upsertExtractToPg(opts: {
  textSha256: string;
  promptVersion: string;
  symbol: string;
  callDate: string;
  fyQuarter: string;
  sourceUrl: string;
  extract: CachedCallExtract;
  modelId: string;
}): Promise<void> {
  await initPgSchema();
  await getPool().query(
    `INSERT INTO call_extracts (
       text_sha256, prompt_version, symbol, call_date, fy_quarter, source_url,
       extract_json, model_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (text_sha256, prompt_version) DO UPDATE SET
       symbol = EXCLUDED.symbol,
       call_date = EXCLUDED.call_date,
       fy_quarter = EXCLUDED.fy_quarter,
       source_url = EXCLUDED.source_url,
       extract_json = EXCLUDED.extract_json,
       model_id = EXCLUDED.model_id`,
    [
      opts.textSha256,
      opts.promptVersion,
      opts.symbol,
      opts.callDate,
      opts.fyQuarter,
      opts.sourceUrl,
      JSON.stringify(opts.extract),
      opts.modelId,
    ]
  );
}

export function countMissingExtracts(
  transcripts: Array<{ text: string }>,
  promptVersion = PROMPT_VERSION
): number {
  let missing = 0;
  for (const t of transcripts) {
    if (!getCachedExtract(sha256Text(t.text), promptVersion)) missing++;
  }
  return missing;
}

/** Latest cached extract per (symbol, call_date, source_url) for cheap rescore. */
export function listCallExtractsForSymbol(symbol: string): CachedCallExtract[] {
  const sym = symbol.trim().toUpperCase();
  const rows = getDb()
    .prepare(
      `SELECT extract_json as extractJson, call_date as callDate, created_at as createdAt
       FROM call_extracts
       WHERE symbol = ?
       ORDER BY created_at DESC`
    )
    .all(sym) as Array<{ extractJson: string; callDate: string; createdAt: string }>;

  const seen = new Set<string>();
  const out: CachedCallExtract[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.extractJson) as CachedCallExtract;
      const key = `${parsed.callDate || row.callDate}|${parsed.sourceUrl || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(parsed);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}
