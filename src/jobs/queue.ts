import { ANALYZE_JOB_MAX_ATTEMPTS } from "../config.ts";
import { getDb, nowIso } from "../db.ts";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export type AnalysisJob = {
  id: number;
  symbol: string;
  jobType: string;
  status: JobStatus;
  force: boolean;
  attempts: number;
  errorMessage: string | null;
  resultJson: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

function rowToJob(row: Record<string, unknown>): AnalysisJob {
  return {
    id: Number(row.id),
    symbol: String(row.symbol),
    jobType: String(row.jobType ?? row.job_type),
    status: String(row.status) as JobStatus,
    force: Boolean(row.force),
    attempts: Number(row.attempts ?? 0),
    errorMessage: (row.errorMessage ?? row.error_message ?? null) as string | null,
    resultJson: (row.resultJson ?? row.result_json ?? null) as string | null,
    createdAt: String(row.createdAt ?? row.created_at),
    startedAt: (row.startedAt ?? row.started_at ?? null) as string | null,
    completedAt: (row.completedAt ?? row.completed_at ?? null) as string | null,
  };
}

const JOB_SELECT = `SELECT id, symbol, job_type as jobType, status, force, attempts,
  error_message as errorMessage, result_json as resultJson,
  created_at as createdAt, started_at as startedAt, completed_at as completedAt
  FROM analysis_jobs`;

/** Enqueue analyze unless the same symbol is already queued or running. */
export function enqueueAnalyzeJob(symbol: string, opts: { force?: boolean } = {}): AnalysisJob {
  const sym = symbol.trim().toUpperCase();
  const db = getDb();
  const existing = db
    .prepare(
      `${JOB_SELECT} WHERE symbol = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1`
    )
    .get(sym) as Record<string, unknown> | undefined;
  if (existing) return rowToJob(existing);

  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO analysis_jobs (symbol, job_type, status, force, attempts, created_at)
       VALUES (?, 'analyze', 'queued', ?, 0, ?)`
    )
    .run(sym, opts.force ? 1 : 0, ts);
  return getJob(Number(info.lastInsertRowid))!;
}

export function getJob(id: number): AnalysisJob | null {
  const row = getDb()
    .prepare(`${JOB_SELECT} WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

/** Atomically claim the next queued job (safe under parallel workers). */
export function claimNextJob(): AnalysisJob | null {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(`${JOB_SELECT} WHERE status = 'queued' ORDER BY id ASC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    const id = Number(row.id);
    const attempts = Number(row.attempts ?? 0) + 1;
    const ts = nowIso();
    const updated = db
      .prepare(
        `UPDATE analysis_jobs
         SET status = 'running', started_at = ?, attempts = ?, error_message = NULL
         WHERE id = ? AND status = 'queued'`
      )
      .run(ts, attempts, id);
    if (updated.changes === 0) {
      db.exec("COMMIT");
      return null;
    }
    db.exec("COMMIT");
    return getJob(id);
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function completeJob(id: number, result: unknown): void {
  getDb()
    .prepare(
      `UPDATE analysis_jobs
       SET status = 'completed', completed_at = ?, result_json = ?, error_message = NULL
       WHERE id = ?`
    )
    .run(nowIso(), JSON.stringify(result), id);
}

/**
 * Mark failed; auto-requeue when attempts < ANALYZE_JOB_MAX_ATTEMPTS.
 * Returns whether the job was requeued.
 */
export function failJob(id: number, errorMessage: string): { requeued: boolean } {
  const job = getJob(id);
  const attempts = job?.attempts ?? 1;
  const canRetry = attempts < ANALYZE_JOB_MAX_ATTEMPTS;
  if (canRetry) {
    getDb()
      .prepare(
        `UPDATE analysis_jobs
         SET status = 'queued', started_at = NULL, completed_at = NULL, error_message = ?
         WHERE id = ?`
      )
      .run(`retry ${attempts}/${ANALYZE_JOB_MAX_ATTEMPTS}: ${errorMessage}`, id);
    console.log(
      `[queue] job #${id} ${job?.symbol ?? "?"} requeued (attempt ${attempts}/${ANALYZE_JOB_MAX_ATTEMPTS})`
    );
    return { requeued: true };
  }
  getDb()
    .prepare(
      `UPDATE analysis_jobs
       SET status = 'failed', completed_at = ?, error_message = ?
       WHERE id = ?`
    )
    .run(nowIso(), errorMessage, id);
  return { requeued: false };
}

/** Requeue failed jobs (and optionally stale running) so the worker can drain them. */
export function requeueFailedJobs(opts: { includeStaleRunningMinutes?: number } = {}): number {
  const db = getDb();
  let n = 0;
  const failed = db
    .prepare(`UPDATE analysis_jobs SET status = 'queued', started_at = NULL, completed_at = NULL WHERE status = 'failed'`)
    .run();
  n += Number(failed.changes ?? 0);

  const staleMin = opts.includeStaleRunningMinutes ?? 45;
  if (staleMin > 0) {
    const cutoff = new Date(Date.now() - staleMin * 60_000).toISOString();
    const stale = db
      .prepare(
        `UPDATE analysis_jobs
         SET status = 'queued', started_at = NULL, completed_at = NULL,
             error_message = COALESCE(error_message, 'requeued stale running')
         WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`
      )
      .run(cutoff);
    n += Number(stale.changes ?? 0);
  }
  return n;
}

export function jobCounts(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT status, COUNT(*) as c FROM analysis_jobs GROUP BY status`)
    .all() as Array<{ status: string; c: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}
