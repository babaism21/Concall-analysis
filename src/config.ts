import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DATA_DIR = join(ROOT, "data");
export const PDF_DIR = join(DATA_DIR, "pdfs");
export const DB_PATH = join(DATA_DIR, "concall.db");
export const PUBLIC_DIR = join(ROOT, "public");

export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
export const MODEL_ID = process.env.MODEL_ID ?? "anthropic/claude-sonnet-5";
export const PROMPT_VERSION = "mgmt-health-v1";
export const MAX_TRANSCRIPTS = Number(process.env.MAX_TRANSCRIPTS ?? 8);
export const PORT = Number(process.env.PORT ?? 8787);
export const USER_AGENT =
  process.env.USER_AGENT ??
  "Mozilla/5.0 (compatible; ConcallAnalysis/0.1; +https://github.com/babaism21/Concall-analysis)";

/** Soft cap per transcript sent to the LLM (chars). Keep lean — 8×25k blows context/cost. */
export const TRANSCRIPT_CHAR_CAP = 15_000;

export function ensureDataDirs() {
  mkdirSync(PDF_DIR, { recursive: true });
}
