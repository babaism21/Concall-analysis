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
  `);
  return db;
}
