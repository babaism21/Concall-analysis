/**
 * Thesis CLI — separate entry point, so the existing src/cli.ts is untouched.
 *
 *   npx tsx src/thesis/cli.ts test WABAG "my thesis…" --wrong-if "…" --wrong-if "…"
 *   npx tsx src/thesis/cli.ts list
 *   npx tsx src/thesis/cli.ts show 1
 *   npx tsx src/thesis/cli.ts recheck 1          # no model calls; uses latest fundamentals
 *   npx tsx src/thesis/cli.ts close 1 right "what I learned"
 *   npx tsx src/thesis/cli.ts metrics WABAG      # just the computed numbers + blind spots
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts"; // also loads .env
import { JsonFileProvider } from "./fundamentals.ts";
import { recheckCard, testThesis } from "./engine.ts";
import { computeMetrics } from "./metrics.ts";
import { findBlindSpots, fmt } from "./rules.ts";
import { renderCard } from "./render.ts";
import { addVersion, closeThesis, getLatest, listTheses, saveNewThesis } from "./store.ts";

const provider = new JsonFileProvider();

function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === flag && args[i + 1]) out.push(args[i + 1]); });
  return out;
}
function positional(args: string[]): string[] {
  return args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
}
function writeOut(name: string, md: string) {
  const dir = join(DATA_DIR, "thesis-cards");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, md);
  return p;
}

async function loadFundamentals(symbol: string) {
  const f = await provider.get(symbol);
  if (!f) {
    throw new Error(
      `No fundamentals for ${symbol}. Add data/fundamentals/${symbol.toUpperCase()}.json ` +
        `(same shape as examples/thesis/WABAG.fundamentals.json).`
    );
  }
  return f;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const pos = positional(rest);

  if (cmd === "test") {
    const [symbol, thesis] = pos;
    if (!symbol || !thesis) throw new Error(`Usage: test SYMBOL "thesis" [--wrong-if "…"]`);
    const card = await testThesis({
      symbol,
      thesis,
      wrongIf: flagValues(rest, "--wrong-if"),
      fundamentals: await loadFundamentals(symbol),
    });
    const id = saveNewThesis(card);
    const md = renderCard(card);
    console.log(md);
    console.log(`\nSaved as thesis #${id} → ${writeOut(`${card.symbol}-${id}-v1.md`, md)}`);
    return;
  }

  if (cmd === "list") {
    const rows = listTheses();
    if (!rows.length) return console.log("No saved theses yet.");
    for (const r of rows) console.log(`#${r.id}  ${r.symbol.padEnd(12)} ${r.headline.padEnd(10)} ${r.status.padEnd(7)} v${r.versions}  ${r.updatedAt}`);
    return;
  }

  if (cmd === "show") {
    const t = getLatest(Number(pos[0]));
    if (!t) throw new Error(`No thesis #${pos[0]}`);
    console.log(renderCard(t.card));
    return;
  }

  if (cmd === "recheck") {
    const t = getLatest(Number(pos[0]));
    if (!t) throw new Error(`No thesis #${pos[0]}`);
    const { card, changes } = recheckCard(t.card, await loadFundamentals(t.symbol));
    const v = addVersion(t.id, card, "recheck", changes);
    const md = renderCard(card, changes.length ? changes : ["Nothing material changed."]);
    console.log(md);
    console.log(`\nSaved as v${v} → ${writeOut(`${card.symbol}-${t.id}-v${v}.md`, md)}`);
    return;
  }

  if (cmd === "close") {
    const [id, outcome, ...words] = pos;
    if (!["right", "wrong", "mixed"].includes(outcome)) throw new Error(`Usage: close ID right|wrong|mixed "reflection"`);
    closeThesis(Number(id), outcome as "right" | "wrong" | "mixed", words.join(" "));
    console.log(`Closed thesis #${id} as ${outcome}.`);
    return;
  }

  if (cmd === "metrics") {
    const f = await loadFundamentals(pos[0] ?? "");
    const { metrics } = computeMetrics(f);
    for (const m of Object.values(metrics)) console.log(`${m!.label}: ${fmt(m!.value, m!.unit)}   (${m!.working})`);
    console.log("\nBlind spots:");
    for (const b of findBlindSpots(metrics, [])) console.log(`- [${b.severity}] ${b.title}: ${b.detail}`);
    return;
  }

  console.log(`Commands: test | list | show | recheck | close | metrics  (see top of src/thesis/cli.ts)`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
