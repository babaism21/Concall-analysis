export const HEALTHCHECK_SYSTEM = `You are an equity research analyst specializing in Indian listed companies.
Analyze management credibility from earnings conference call transcripts.

Rules:
- Use ONLY the provided transcript text. Do not invent numbers or commitments.
- Focus on guidance vs delivery across quarters: what was promised, what was delivered later.
- Every Evidence / Quote field MUST be a short verbatim substring copied from the transcripts (for deep-linking).
- Be specific (metrics, timelines, status). Mark uncertainty explicitly.
- Output structured markdown exactly in the section order requested.`;

export function buildHealthcheckUserPrompt(
  symbol: string,
  blocks: Array<{ fyQuarter: string; callDate: string; text: string }>
): string {
  const body = blocks
    .map(
      (b, i) =>
        `### Call ${i + 1}: ${b.fyQuarter} (filed/call month ${b.callDate})\n\n${b.text}`
    )
    .join("\n\n---\n\n");

  return `Symbol: ${symbol}

Below are the latest conference call transcripts (newest first), cleaned.
(Some older/longer calls may be shortened only for model context; the product stores full text.)

Produce markdown with these exact sections:

## Management Health Summary
2-4 sentences on delivery credibility.

## Commitments Table
A markdown table with columns:
| Quarter | Commitment | Status | Evidence |
Status must be exactly one of: Met | Partially Completed | Under Execution | Early Execution | Not Met
Evidence must be a short verbatim quote (≤25 words) copied from the transcripts.

Include 6–15 of the most material commitments spanning the provided calls. Prefer measurable guidance (growth, margins, order book, capex, launches, NPAs, etc.).

## Insight Cards
Bullet list of 8–14 recent insights (newest calls first). Each bullet:
- **KIND** — TITLE — QUARTER — "verbatim quote ≤20 words"
KIND is one of: DELIVERED | MISSED | OPEN | RISK | GUIDANCE

## Red Flags
Bullet list (or "None material").

## Quarterly Timeline
For each call (newest→oldest): one line with an implied delivery score 0–10 and a short note (beats / misses / transparency).

## Bottom Line
One paragraph investment takeaway on management quality from these calls only.

Transcripts:
${body}`;
}

export const JSON_EXTRACT_SYSTEM = `Extract structured JSON from a management healthcheck markdown report.
Return ONLY valid JSON matching the schema. No markdown fences.
Quotes must stay verbatim from the markdown/evidence fields.`;

export function buildJsonExtractPrompt(markdown: string): string {
  return `From this management healthcheck markdown, extract JSON:

{
  "rawScore": <number 0-10 average of quarterly timeline scores if present, else null>,
  "redFlags": ["..."],
  "commitments": [
    {
      "quarter": "...",
      "commitment": "...",
      "status": "Met|Partially Completed|Under Execution|Early Execution|Not Met",
      "evidence": "...",
      "quote": "verbatim evidence quote"
    }
  ],
  "insights": [
    {
      "kind": "delivered|missed|open|risk|guidance",
      "title": "...",
      "body": "...",
      "quarter": "...",
      "quote": "verbatim quote"
    }
  ],
  "timeline": [
    { "quarter": "...", "score": <0-10>, "note": "..." }
  ],
  "summary": "short summary"
}

Markdown:
${markdown}`;
}
