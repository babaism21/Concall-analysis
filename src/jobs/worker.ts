import { WORKER_CONCURRENCY } from "../config.ts";
import { getDb } from "../db.ts";
import { analyzeSymbol } from "../analyze/run.ts";
import { claimNextJob, completeJob, failJob, type AnalysisJob } from "./queue.ts";

let inFlight = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let kicking = false;

function recoverOrphanedRunningJobs(): number {
  const result = getDb()
    .prepare(
      `UPDATE analysis_jobs
       SET status = 'queued', started_at = NULL, completed_at = NULL,
           attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
           error_message = COALESCE(error_message, 'recovered after worker restart')
       WHERE status = 'running'`
    )
    .run();
  return Number(result.changes ?? 0);
}

async function runClaimedJob(job: AnalysisJob): Promise<void> {
  console.log(
    `[worker] job #${job.id} analyze ${job.symbol} force=${job.force} attempt=${job.attempts} active=${inFlight}/${WORKER_CONCURRENCY}`
  );
  try {
    const result = await analyzeSymbol(job.symbol, {
      force: job.force,
      skipIngest: !job.force,
    });
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
    const { requeued } = failJob(job.id, msg);
    console.error(`[worker] job #${job.id} failed${requeued ? " (requeued)" : ""}: ${msg}`);
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
}

/** Fill up to WORKER_CONCURRENCY parallel analyze slots. */
export async function runWorkerLoopOnce(): Promise<void> {
  if (kicking) return;
  kicking = true;
  try {
    const launches: Promise<void>[] = [];
    while (inFlight < WORKER_CONCURRENCY) {
      const job = claimNextJob();
      if (!job) break;
      inFlight++;
      launches.push(runClaimedJob(job));
    }
    if (launches.length) await Promise.all(launches);
  } finally {
    kicking = false;
  }
}

/** Background poller used by `npm run serve`. */
export function startAnalyzeWorker(pollMs = 2000): void {
  if (timer) return;
  const recovered = recoverOrphanedRunningJobs();
  if (recovered > 0) {
    console.log(`[worker] recovered ${recovered} orphaned running job(s) → queued`);
  }
  console.log(
    `[worker] analyze worker started (poll=${pollMs}ms concurrency=${WORKER_CONCURRENCY})`
  );
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
