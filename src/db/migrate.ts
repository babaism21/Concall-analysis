import { existsSync } from "node:fs";
import { DB_PATH } from "../config.ts";
import { closePool, initPgSchema, isPostgresEnabled, pingPostgres } from "./pg.ts";
import { syncAllSymbolsToPostgres } from "./sync.ts";

export async function migrateSqliteToPostgres(): Promise<void> {
  if (!isPostgresEnabled()) {
    console.error("USE_POSTGRES is not enabled. Set USE_POSTGRES=true in .env");
    process.exit(1);
  }

  const ok = await pingPostgres();
  if (!ok) {
    console.error("Cannot connect to Postgres. Run: docker compose up -d");
    process.exit(1);
  }

  await initPgSchema();

  if (!existsSync(DB_PATH)) {
    console.log("[migrate] no SQLite database found — schema ready, nothing to migrate");
    return;
  }

  await syncAllSymbolsToPostgres();
  console.log("[migrate] done");
  await closePool();
}
