/**
 * Fundamentals providers. The engine only depends on the `Fundamentals`
 * contract in types.ts, so a paid API (Indian Stock API, CMOTS, Accord…)
 * can be dropped in later by implementing `FundamentalsProvider`.
 *
 * For now: JSON files. Lookup order:
 *   1. data/fundamentals/<SYMBOL>.json   (your own pulls; gitignored)
 *   2. examples/thesis/<SYMBOL>.fundamentals.json   (bundled fixtures)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, EXAMPLES_DIR } from "../config.ts";
import type { Fundamentals } from "./types.ts";

export interface FundamentalsProvider {
  name: string;
  get(symbol: string): Promise<Fundamentals | null>;
}

export class JsonFileProvider implements FundamentalsProvider {
  name = "json-file";
  constructor(private dirs: string[] = [join(DATA_DIR, "fundamentals"), join(EXAMPLES_DIR, "thesis")]) {}

  async get(symbol: string): Promise<Fundamentals | null> {
    const sym = symbol.trim().toUpperCase();
    for (const dir of this.dirs) {
      for (const file of [`${sym}.json`, `${sym}.fundamentals.json`]) {
        const p = join(dir, file);
        if (existsSync(p)) return validateFundamentals(JSON.parse(readFileSync(p, "utf8")));
      }
    }
    return null;
  }
}

/** Light structural check so a bad file fails loudly instead of producing silent NaNs. */
export function validateFundamentals(raw: unknown): Fundamentals {
  const f = raw as Fundamentals;
  const problems: string[] = [];
  if (!f || typeof f !== "object") throw new Error("Fundamentals file is not an object");
  if (!f.symbol) problems.push("symbol missing");
  if (!(f.price > 0)) problems.push("price must be > 0");
  if (!(f.marketCapCr > 0)) problems.push("marketCapCr must be > 0");
  if (!Array.isArray(f.quarters)) problems.push("quarters must be an array");
  if (!Array.isArray(f.annual)) problems.push("annual must be an array");
  for (const q of f.quarters ?? []) {
    for (const k of ["sales", "operatingProfit", "otherIncome", "pbt", "netProfit"] as const) {
      if (typeof q[k] !== "number") problems.push(`quarter ${q.period}: ${k} must be a number`);
    }
  }
  if (problems.length) throw new Error(`Invalid fundamentals for ${f?.symbol ?? "?"}: ${problems.join("; ")}`);
  return f;
}
