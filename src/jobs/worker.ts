import { analyzeSymbol } from "../analyze/run.ts";
import { claimNextJob, completeJob, failJob } from "./queue.ts";

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function processOne(): Promise<boolean> {
  const job = claimNextJob();
  if (!job) return false;
  console.log(`[worker] job #${job.id} analyze ${job.symbol} force=${job.force}`);
  try {
    const result = await analyzeSymbol(job.symbol, { force: job.force });
    completeJob(job.id, {
      symbol: result.symbol,
      healthScore: result.portfolioJson.healthScore,
      label: result.portfolioJson.label,
      transcriptCount: result.transcriptCount,
      insightCount: result.portfolioJson.insights?.length ?? 0,
    });
    console.log(`[worker] job #${job.id} completed ${job.symbol}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failJob(job.id, msg);
    console.error(`[worker] job #${job.id} failed: ${msg}`);
  }
  return true;
}

export async function runWorkerLoopOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (await processOne()) {
      /* drain queue */
    }
  } finally {
    running = false;
  }
}

/** Background poller used by `npm run serve`. */
export function startAnalyzeWorker(pollMs = 2000): void {
  if (timer) return;
  console.log(`[worker] analyze worker started (poll=${pollMs}ms)`);
  timer = setInterval(() => {
    void runWorkerLoopOnce();
  }, pollMs);
  void runWorkerLoopOnce();
}

export function stopAnalyzeWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
