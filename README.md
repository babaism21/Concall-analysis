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
# Default model: moonshotai/kimi-k2.5 (cheap). Override with MODEL_ID=...

# If UI still shows "[... truncated ...]", force full PDF→text refresh:
npm run reparse -- HDFCBANK

# First analysis (needs API key)
npm run analyze -- HDFCBANK

# Read cache only (no API key)
npm run get -- HDFCBANK

# API + UI
npm run serve
```

**Full transcripts in UI.** Truncation applies only when packing text into the LLM prompt (Kimi large context → much less need to cut).

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

**Analyze once → reuse until a newer concall appears.**

| Action | API | LLM? | API key? |
|--------|-----|------|----------|
| **Show** | `GET /analysis/:symbol` | Never | No |
| **Check for updates** | `POST /analyze/:symbol` | Only if newest transcript URL changed (or `?force=1`) | Only when LLM runs |

`GET` order: SQLite `data/concall.db` → bundled `examples/{SYMBOL}.json` (then seeded into SQLite).

**Transcripts are stored in full.** The `[... truncated ...]` marker was a bug (cap applied at parse time). Truncation now applies **only** when building the LLM prompt (`TRANSCRIPT_CHAR_CAP`), never in the UI.

## Env

| Var | Required | Default |
|-----|----------|---------|
| `OPENROUTER_API_KEY` | only for first analyze / when a newer concall appears | — |
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
| Cache until new concall | ✅ |
| Portfolio rollup | ⏳ next |
| Quote grounding verify | ⏳ later |
