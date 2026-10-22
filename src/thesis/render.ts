/** Render a ThesisCard as readable markdown (terminal / file / later the UI). */
import { fmt } from "./rules.ts";
import type { ThesisCard, Verdict } from "./types.ts";

const ICON: Record<Verdict, string> = {
  Supported: "✅",
  Weak: "🟡",
  Contradicted: "❌",
  Unverifiable: "❔",
  Pending: "⏳",
};

export function renderCard(card: ThesisCard, changes: string[] = []): string {
  const out: string[] = [];
  out.push(`# Thesis card: ${card.symbol}`);
  out.push(`**${card.headline}** — ${card.headlineReason}`);
  out.push(`_Data as of ${card.dataAsOf ?? "unknown"} · ${card.engineVersion} · ${card.modelId ?? ""}_`);
  if (changes.length) {
    out.push(`\n## What changed`);
    for (const c of changes) out.push(`- ${c}`);
  }
  out.push(`\n> ${card.thesisText.replace(/\n/g, "\n> ")}`);

  const c = card.counts;
  out.push(`\n## Claims  (${c.Supported} supported · ${c.Weak} weak · ${c.Contradicted} contradicted · ${c.Unverifiable} unverifiable · ${c.Pending} pending)`);
  for (const cl of card.claims) {
    out.push(`\n**${ICON[cl.verdict]} ${cl.verdict}** · ${cl.importance}${cl.isMacro ? " · macro" : ""} · ${cl.type} · by ${cl.verdictBy} (${cl.confidence})`);
    out.push(`"${cl.text}"`);
    out.push(`${cl.reason}`);
    for (const e of cl.evidence) out.push(`  - ${e.text}`);
  }

  if (card.blindSpots.length) {
    out.push(`\n## Blind spots`);
    for (const b of card.blindSpots) out.push(`- **[${b.severity}] ${b.title}.** ${b.detail}`);
  }

  if (card.coachingQuestions.length) {
    out.push(`\n## Questions to sharpen your thesis`);
    for (const q of card.coachingQuestions) out.push(`- ${q}`);
  }
  if (card.suggestedRewrite) out.push(`\n**Suggested rewrite:** ${card.suggestedRewrite}`);

  out.push(`\n## I'm wrong if…`);
  if (card.triggers.length) {
    for (const t of card.triggerStatus) {
      const icon = t.status === "fired" ? "🚨" : t.status === "ok" ? "✔️" : t.status === "manual" ? "👁️" : "…";
      out.push(`- ${icon} ${t.text} — ${t.status} (${t.detail})`);
    }
  } else {
    out.push(`You didn't write any. Suggestions (add with --wrong-if):`);
    for (const s of card.suggestedTriggers) out.push(`- ${s.text}`);
  }

  out.push(`\n<details><summary>Numbers used</summary>\n`);
  for (const m of Object.values(card.metrics)) out.push(`- ${m!.label}: ${fmt(m!.value, m!.unit)} (${m!.working})`);
  out.push(`</details>`);
  out.push(`\n_${card.disclaimer}_`);
  return out.join("\n");
}
