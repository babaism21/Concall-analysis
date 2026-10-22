/**
 * Thesis storage. Uses its OWN SQLite file (data/thesis.db) so the existing
 * concall database and schema are never touched. Every test or re-check is
 * saved as a new version, so the full history of a thesis is kept.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { DATA_DIR, ensureDataDirs } from "../config.ts";
import type { ThesisCard } from "./types.ts";

let db: DatabaseSync | null = null;

export function getThesisDb(path = join(DATA_DIR, "thesis.db")): DatabaseSync {
  if (db) return db;
  ensureDataDirs();
  db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS theses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',   -- active | closed
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      outcome TEXT,                            -- right | wrong | mixed (filled when closed)
      reflection TEXT
    );
    CREATE TABLE IF NOT EXISTS thesis_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thesis_id INTEGER NOT NULL REFERENCES theses(id),
      version INTEGER NOT NULL,
      kind TEXT NOT NULL,                      -- test | recheck
      headline TEXT NOT NULL,
      card_json TEXT NOT NULL,
      changes_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(thesis_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_theses_symbol ON theses(symbol);
  `);
  return db;
}

/** For tests: use an isolated database file. */
export function useThesisDb(path: string) {
  db = null;
  return getThesisDb(path);
}

export function saveNewThesis(card: ThesisCard): number {
  const d = getThesisDb();
  const now = new Date().toISOString();
  const res = d.prepare(`INSERT INTO theses (symbol, created_at, updated_at) VALUES (?, ?, ?)`).run(card.symbol, now, now);
  const id = Number(res.lastInsertRowid);
  addVersion(id, card, "test", []);
  return id;
}

export function addVersion(thesisId: number, card: ThesisCard, kind: "test" | "recheck", changes: string[]): number {
  const d = getThesisDb();
  const row = d.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM thesis_versions WHERE thesis_id = ?`).get(thesisId) as { v: number };
  const version = row.v + 1;
  d.prepare(
    `INSERT INTO thesis_versions (thesis_id, version, kind, headline, card_json, changes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(thesisId, version, kind, card.headline, JSON.stringify(card), JSON.stringify(changes), card.createdAt);
  d.prepare(`UPDATE theses SET updated_at = ? WHERE id = ?`).run(card.createdAt, thesisId);
  return version;
}

export type StoredThesis = { id: number; symbol: string; status: string; version: number; card: ThesisCard };

export function getLatest(thesisId: number): StoredThesis | null {
  const row = getThesisDb()
    .prepare(
      `SELECT t.id, t.symbol, t.status, v.version, v.card_json
       FROM theses t JOIN thesis_versions v ON v.thesis_id = t.id
       WHERE t.id = ? ORDER BY v.version DESC LIMIT 1`
    )
    .get(thesisId) as { id: number; symbol: string; status: string; version: number; card_json: string } | undefined;
  if (!row) return null;
  return { id: row.id, symbol: row.symbol, status: row.status, version: row.version, card: JSON.parse(row.card_json) };
}

export function listTheses(): Array<{ id: number; symbol: string; status: string; headline: string; versions: number; updatedAt: string }> {
  return getThesisDb()
    .prepare(
      `SELECT t.id, t.symbol, t.status, t.updated_at AS updatedAt,
              (SELECT headline FROM thesis_versions WHERE thesis_id = t.id ORDER BY version DESC LIMIT 1) AS headline,
              (SELECT COUNT(*) FROM thesis_versions WHERE thesis_id = t.id) AS versions
       FROM theses t ORDER BY t.updated_at DESC`
    )
    .all() as Array<{ id: number; symbol: string; status: string; headline: string; versions: number; updatedAt: string }>;
}

export function closeThesis(thesisId: number, outcome: "right" | "wrong" | "mixed", reflection: string) {
  getThesisDb()
    .prepare(`UPDATE theses SET status = 'closed', closed_at = ?, outcome = ?, reflection = ? WHERE id = ?`)
    .run(new Date().toISOString(), outcome, reflection, thesisId);
}
