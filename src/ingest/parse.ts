import { readFileSync } from "node:fs";
// pdf-parse is CJS; default import works under NodeNext + tsx.
import pdf from "pdf-parse";
import { TRANSCRIPT_CHAR_CAP } from "../config.ts";

/**
 * Trim preamble: keep from first speaker turn after a "moderator" cue when possible.
 * Cap length for LLM context.
 */
export function cleanTranscriptText(raw: string, cap = TRANSCRIPT_CHAR_CAP): string {
  let text = raw.replace(/\r/g, "\n");
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");

  const lower = text.toLowerCase();
  const modIdx = lower.search(/\bmoderator\b/);
  if (modIdx >= 0) {
    const after = text.slice(modIdx);
    const speaker = after.search(
      /\n\s*(?:[A-Z][A-Za-z .'-]{2,40}\s*:\s|[A-Z][A-Za-z .'-]{2,40}\s*–)/
    );
    if (speaker > 0 && speaker < 4000) {
      text = after.slice(speaker).trim();
    } else {
      text = after.trim();
    }
  }

  if (text.length > cap) {
    text = text.slice(0, cap) + "\n\n[... truncated for analysis context ...]";
  }
  return text.trim();
}

export async function parsePdfToText(pdfPath: string): Promise<{ text: string; charCount: number }> {
  const data = readFileSync(pdfPath);
  const parsed = await pdf(data);
  const cleaned = cleanTranscriptText(parsed.text || "");
  return { text: cleaned, charCount: cleaned.length };
}
