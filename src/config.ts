import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnvFile();

export const DATA_DIR = join(ROOT, "data");
export const PDF_DIR = join(DATA_DIR, "pdfs");
export const BLOB_DIR = join(DATA_DIR, "blobs", "pdfs");
export const DB_PATH = join(DATA_DIR, "concall.db");

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://concall:concall@localhost:5432/concall";

export const USE_POSTGRES =
  process.env.USE_POSTGRES === "true" || process.env.USE_POSTGRES === "1";
export const PUBLIC_DIR = join(ROOT, "public");
export const EXAMPLES_DIR = join(ROOT, "examples");
export const ROOT_DIR = ROOT;

export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

/**
 * Default: Kimi K2.5 via OpenRouter — large context + low $/MTok vs Claude Sonnet.
 * Override with MODEL_ID=anthropic/claude-sonnet-5 for higher quality passes.
 */
export const MODEL_ID = process.env.MODEL_ID ?? "moonshotai/kimi-k2.5";

export const PROMPT_VERSION = "mgmt-health-v5-quarter-scores";
export const MAX_TRANSCRIPTS = Number(process.env.MAX_TRANSCRIPTS ?? 8);
export const ANALYZE_CONCURRENCY = Math.max(1, Number(process.env.ANALYZE_CONCURRENCY ?? 3));
export const PORT = Number(process.env.PORT ?? 8787);
export const USER_AGENT =
  process.env.USER_AGENT ??
  "Mozilla/5.0 (compatible; ConcallAnalysis/0.1; +https://github.com/babaism21/Concall-analysis)";

/**
 * Soft per-call char hint when packing LLM context (UI always stores FULL text).
 * With Kimi ~262k ctx, keep a total budget instead of blindly slicing every call to 15k.
 */
export const TRANSCRIPT_CHAR_CAP = Number(process.env.TRANSCRIPT_CHAR_CAP ?? 80_000);

/** Total transcript chars sent to the LLM across all quarters (newest first). */
export const LLM_TOTAL_CHAR_BUDGET = Number(process.env.LLM_TOTAL_CHAR_BUDGET ?? 220_000);

export function ensureDataDirs() {
  mkdirSync(PDF_DIR, { recursive: true });
  mkdirSync(BLOB_DIR, { recursive: true });
}
