export const PER_CALL_SYSTEM = `You are an equity research analyst reading ONE Indian earnings conference call transcript.
Extract quarter-level operational updates and management signals.

Rules:
- Use ONLY the provided transcript. Do not invent numbers or events.
- Every quote MUST be a verbatim substring copied from the transcript (for deep-linking in the UI).
- Be specific: metrics, projects, timelines, order wins, margin/cashflow commentary.
- Return ONLY valid JSON matching the schema. No markdown fences.`;

export function buildPerCallPrompt(
  symbol: string,
  call: { fyQuarter: string; callDate: string; text: string }
): string {
  return `Symbol: ${symbol}
Quarter: ${call.fyQuarter}
Call date: ${call.callDate}

Return ONLY this JSON object:
{
  "positive": [
    { "title": "short headline", "body": "1-2 sentences", "quote": "verbatim ≤30 words from transcript" }
  ],
  "negative": [
    { "title": "short headline", "body": "1-2 sentences", "quote": "verbatim ≤30 words from transcript" }
  ],
  "guidance": [
    { "title": "short headline", "body": "new forward guidance stated on this call", "quote": "verbatim ≤30 words" }
  ],
  "risks": [
    { "title": "short headline", "body": "material risk flagged on this call", "quote": "verbatim ≤30 words" }
  ],
  "callScore": <number 0-10 with ONE decimal allowed: credibility on THIS call ONLY>,
  "summary": "2-3 sentence headline for this quarter's concall"
}

Requirements:
- positive: exactly 3 items
- negative: exactly 3 items
- guidance: 0–2 items
- risks: 0–2 items
- callScore MUST reflect THIS call only (not a company average). Use the full 0–10 range.
  Start at 6.5, then: major delivery miss -1.5 to -2.5; guidance cut/flip-flop -1.0; evasive Q&A -0.5 to -1.0;
  major beat/clear delivery +1.0 to +2.0; exceptional transparency +0.5. Avoid defaulting to 7–8.
- Keep titles under 8 words; bodies under 120 chars; quotes under 25 words

Transcript:
${call.text}`;
}

export const SYNTHESIS_SYSTEM = `You are an equity research analyst synthesizing multiple concall summaries for one Indian stock.
Focus on cross-quarter promise vs delivery: what management guided in earlier calls vs what they reported later.

Rules:
- Use ONLY the per-call summaries and guidance bullets provided.
- Commitments must reference measurable prior guidance tracked across quarters.
- Return ONLY valid JSON. No markdown fences.`;

export type PerCallSummaryInput = {
  fyQuarter: string;
  callDate: string;
  summary: string;
  callScore: number;
  guidance: Array<{ title: string; body: string }>;
  negative: Array<{ title: string; body: string }>;
};

export function buildSynthesisPrompt(symbol: string, calls: PerCallSummaryInput[]): string {
  const body = calls
    .map(
      (c, i) =>
        `### Call ${i + 1}: ${c.fyQuarter} (${c.callDate}) — callScore ${c.callScore}
Summary: ${c.summary}
Guidance stated: ${c.guidance.map((g) => g.title).join("; ") || "none noted"}
Key negatives: ${c.negative.map((n) => n.title).join("; ") || "none noted"}`
    )
    .join("\n\n");

  return `Symbol: ${symbol}

Per-call extracts (newest first):
${body}

Return ONLY this JSON:
{
  "summary": "3-4 sentence management health narrative across all calls",
  "rawScore": <number 0-10 average credibility across calls>,
  "redFlags": ["cross-quarter red flags — repeated misses, pattern of guidance cuts, governance, etc."],
  "commitments": [
    {
      "quarter": "QXFYXX where promise was made",
      "commitment": "what was promised",
      "status": "Met|Partially Completed|Under Execution|Early Execution|Not Met",
      "evidence": "what happened in later calls",
      "quote": "short evidence phrase"
    }
  ],
  "timeline": [
    { "quarter": "QXFYXX", "score": <0-10>, "note": "one line" }
  ]
}

Include 6–12 cross-quarter commitments where prior guidance can be checked against later delivery.
Include ONE timeline entry per unique call quarter (no duplicate quarter labels).
Timeline scores are recomputed deterministically in code — your notes should explain the quarter,
not invent spread. Prefer status honesty: use Under Execution / Early Execution for on-track open
work; reserve Not Met for clear misses vs prior guidance.`
}

// Legacy bulk prompts kept for reference / fallback
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

Produce markdown with these exact sections:

## Management Health Summary
2-4 sentences on delivery credibility.

## Commitments Table
| Quarter | Commitment | Status | Evidence |

## Red Flags
## Quarterly Timeline
## Bottom Line

Transcripts:
${body}`;
}

export const JSON_EXTRACT_SYSTEM = `Extract structured JSON from a management healthcheck markdown report.
Return ONLY valid JSON matching the schema. No markdown fences.
Quotes must stay verbatim from the markdown/evidence fields.`;

export function buildJsonExtractPrompt(markdown: string): string {
  return `From this management healthcheck markdown, extract JSON:

{
  "rawScore": <number 0-10>,
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
      "kind": "positive|negative|delivered|missed|open|risk|guidance",
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
