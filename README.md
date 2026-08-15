# Concall Analysis

**Product job:** Did management deliver on what they committed in earnings calls?

Module focused on **management health** for Indian listed stocks:

1. Discover last ~8 quarterly concall transcripts (Screener.in → BSE PDFs)
2. Parse + clean transcript text
3. LLM management healthcheck → markdown + commitments + red flags
4. Deterministic health score from commitment statuses
5. Cache until a newer concall appears
6. Thin API + minimal UI (single stock first; portfolio rollup next)

Not a full research chat app. Not coupled to any portfolio OS.

## Quick start

```bash
npm install
cp .env.example .env   # set OPENROUTER_API_KEY

# One-symbol end-to-end
npm run analyze -- HDFCBANK

# Read cache only
npm run get -- HDFCBANK

# API + UI
npm run serve
# POST http://localhost:8787/analyze/HDFCBANK
# GET  http://localhost:8787/analysis/HDFCBANK
# UI   http://localhost:8787/
```

## Architecture

```
src/
  ingest/     Screener URL discovery → PDF download → text parse
  analyze/    prompts, LLM healthcheck, deterministic scoring
  api/        POST /analyze/:symbol, GET /analysis/:symbol
  db.ts       SQLite cache (urls, transcripts, analysis)
public/       minimal single-stock UI
data/         local SQLite + PDFs (gitignored)
```

## Scoring

Commitment status weights (average → 0–100):

| Status | Weight |
|--------|--------|
| Met | 100 |
| Partially Completed | 70 |
| Under Execution | 50 |
| Early Execution | 30 |
| Not Met | 0 |

Labels: **≥75 Good**, **≥50 Average**, else **Weak**.

Headline score = deterministic from commitments. LLM also returns a quarterly timeline 0–10 (display / secondary).

## Cache rule

Analysis is reused until the newest discovered transcript `source_url` changes for that symbol.

## Env

| Var | Required | Default |
|-----|----------|---------|
| `OPENROUTER_API_KEY` | yes (analyze) | — |
| `MODEL_ID` | no | `anthropic/claude-sonnet-5` |
| `PORT` | no | `8787` |
| `MAX_TRANSCRIPTS` | no | `8` |

## Sample output (HDFCBANK, first E2E)

| Field | Value |
|-------|-------|
| Health score | **70 / Average** |
| LLM timeline | 6.5 / 10 |
| Transcripts | 8 |
| Commitments | 12 |

Notable red flags from that run: chairman resignation ambiguity, CEO reappointment vagueness, pending WTD appointment, persistent PSL shortfall.

Full dump: [`examples/HDFCBANK.json`](examples/HDFCBANK.json) · [`examples/HDFCBANK.md`](examples/HDFCBANK.md)

## MVP status

| Piece | Status |
|-------|--------|
| Screener → BSE transcript URLs | ✅ |
| Download + pdf-parse (≤8) | ✅ |
| Healthcheck markdown + JSON | ✅ |
| Deterministic score | ✅ |
| SQLite cache + API | ✅ |
| Minimal UI | ✅ |
| Portfolio rollup | ⏳ next |
| Quote grounding verify | ⏳ later |
