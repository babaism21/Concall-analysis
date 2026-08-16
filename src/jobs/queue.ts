import { getDb, nowIso } from "../db.ts";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export type AnalysisJob = {
  id: number;
  symbol: string;
  jobType: string;
  status: JobStatus;
  force: boolean;
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
    errorMessage: (row.errorMessage ?? row.error_message ?? null) as string | null,
    resultJson: (row.resultJson ?? row.result_json ?? null) as string | null,
    createdAt: String(row.createdAt ?? row.created_at),
    startedAt: (row.startedAt ?? row.started_at ?? null) as string | null,
    completedAt: (row.completedAt ?? row.completed_at ?? null) as string | null,
  };
}

export function enqueueAnalyzeJob(symbol: string, opts: { force?: boolean } = {}): AnalysisJob {
  const sym = symbol.trim().toUpperCase();
  const ts = nowIso();
  const info = getDb()
    .prepare(
      `INSERT INTO analysis_jobs (symbol, job_type, status, force, created_at)
       VALUES (?, 'analyze', 'queued', ?, ?)`
    )
    .run(sym, opts.force ? 1 : 0, ts);
  const id = Number(info.lastInsertRowid);
  return getJob(id)!;
}

export function getJob(id: number): AnalysisJob | null {
  const row = getDb()
    .prepare(
      `SELECT id, symbol, job_type as jobType, status, force, error_message as errorMessage,
              result_json as resultJson, created_at as createdAt, started_at as startedAt,
              completed_at as completedAt
       FROM analysis_jobs WHERE id = ?`
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

export function claimNextJob(): AnalysisJob | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, symbol, job_type as jobType, status, force, error_message as errorMessage,
              result_json as resultJson, created_at as createdAt, started_at as startedAt,
              completed_at as completedAt
       FROM analysis_jobs WHERE status = 'queued'
       ORDER BY id ASC LIMIT 1`
    )
    .get() as Record<string, unknown> | undefined;
  if (!row) return null;
  const id = Number(row.id);
  const ts = nowIso();
  const updated = db
    .prepare(
      `UPDATE analysis_jobs SET status = 'running', started_at = ?
       WHERE id = ? AND status = 'queued'`
    )
    .run(ts, id);
  if (updated.changes === 0) return null;
  return getJob(id);
}

export function completeJob(id: number, result: unknown): void {
  getDb()
    .prepare(
      `UPDATE analysis_jobs SET status = 'completed', completed_at = ?, result_json = ?, error_message = NULL
       WHERE id = ?`
    )
    .run(nowIso(), JSON.stringify(result), id);
}

export function failJob(id: number, errorMessage: string): void {
  getDb()
    .prepare(
      `UPDATE analysis_jobs SET status = 'failed', completed_at = ?, error_message = ?
       WHERE id = ?`
    )
    .run(nowIso(), errorMessage, id);
}
