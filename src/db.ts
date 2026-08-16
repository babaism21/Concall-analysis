import { DatabaseSync } from "node:sqlite";
import { DB_PATH, ensureDataDirs } from "./config.ts";

let db: DatabaseSync | null = null;

export function nowIso() {
  return new Date().toISOString();
}

export function getDb(): DatabaseSync {
  if (db) return db;
  ensureDataDirs();
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS conference_call_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      call_date TEXT NOT NULL,
      source_url TEXT NOT NULL,
      doc_type TEXT NOT NULL DEFAULT 'transcript',
      discovered_at TEXT NOT NULL,
      UNIQUE(symbol, source_url)
    );

    CREATE TABLE IF NOT EXISTS parsed_conference_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      call_date TEXT NOT NULL,
      source_url TEXT NOT NULL,
      fy_quarter TEXT,
      pdf_path TEXT,
      text_content TEXT,
      char_count INTEGER,
      parse_status TEXT NOT NULL DEFAULT 'pending',
      parsed_at TEXT,
      UNIQUE(symbol, source_url)
    );

    CREATE TABLE IF NOT EXISTS management_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL UNIQUE,
      markdown TEXT NOT NULL,
      portfolio_json TEXT NOT NULL,
      latest_source_url TEXT,
      transcript_count INTEGER,
      model_id TEXT,
      prompt_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_extracts (
      text_sha256 TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      symbol TEXT NOT NULL,
      call_date TEXT NOT NULL,
      fy_quarter TEXT,
      source_url TEXT NOT NULL,
      extract_json TEXT NOT NULL,
      model_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (text_sha256, prompt_version)
    );
    CREATE INDEX IF NOT EXISTS idx_call_extracts_symbol ON call_extracts(symbol);

    CREATE TABLE IF NOT EXISTS analysis_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      job_type TEXT NOT NULL DEFAULT 'analyze',
      status TEXT NOT NULL DEFAULT 'queued',
      force INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status ON analysis_jobs(status);
  `);
  return db;
}
