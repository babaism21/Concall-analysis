# Thesis Tester module (`src/thesis/`)

Tests an investor's stock thesis: splits it into claims, checks each against data, finds blind spots, coaches, and re-checks it when new numbers arrive.

**Additive only.** No existing file in this repo was changed. The module reads the existing concall analysis (`getAnalysis`, cache only — it never triggers a new LLM run), reuses the OpenRouter client in `src/llm.ts`, and stores its own data in a separate `data/thesis.db`.

## Pipeline

1. **Extract** (cheap model): thesis → atomic claims (type, core/supporting, macro or company-specific, optional metric check) + parse "I'm wrong if…" lines into rules.
2. **Evidence** (code): `metrics.ts` computes every number with its working; concall commitments/red flags come from the existing module.
3. **Verdicts**: claims with a metric check are decided **by rule**; the rest go to the model, which may only cite numbers we supplied. Guardrails: invented numbers → low confidence; "Supported" with no evidence → downgraded to Weak.
4. **Blind spots + triggers** (code): margin drop, profit outpacing core profit, one-offs, other income reliance, cash conversion, debtor days, pledge, promoter selling.
5. **Coaching** (strong model): up to 3 questions, a rewrite, suggested "I'm wrong if" conditions.
6. **Headline** (code): Holds / Shaky / Broken / Too vague — never a percentage.

`recheckCard` re-runs steps 2, 4 and 6 plus rule-based claims with **no model calls**, so monitoring is cheap.

## Run

```bash
npx tsx --test src/thesis/thesis.test.ts                  # offline tests, no API key
npx tsx src/thesis/cli.ts metrics WABAG                    # numbers + blind spots, no API key
npx tsx src/thesis/cli.ts test WABAG "my thesis…" --wrong-if "Operating margin below 11% for 2 quarters"
npx tsx src/thesis/cli.ts list | show 1 | recheck 1 | close 1 right "what I learned"
```

Needs `OPENROUTER_API_KEY` for `test`. Optional: `THESIS_EXTRACT_MODEL`, `THESIS_JUDGE_MODEL` (default `MODEL_ID`).

## Data

Fundamentals come from JSON (`data/fundamentals/SYMBOL.json`, else `examples/thesis/SYMBOL.fundamentals.json`) in the shape of `Fundamentals` in `types.ts`, money in ₹ crore. To use a real API, implement `FundamentalsProvider` in `fundamentals.ts`.

## Not built yet

- A live fundamentals provider (Indian Stock API or similar)
- HTTP endpoints and UI (would mean editing `src/api/server.ts`)
- Scheduled re-checks and alerts
- Track-record analytics on closed theses
