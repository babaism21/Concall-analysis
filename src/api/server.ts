import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { PORT, PUBLIC_DIR, ENABLE_ANALYZE_WORKER, WORKER_CONCURRENCY } from "../config.ts";
import { analyzeSymbol, getAnalysis } from "../analyze/run.ts";
import { refreshSymbol } from "../ingest/refresh.ts";
import { getStock, listAvailableStocks, stockToUiPayload } from "./v1/stocks.ts";
import { isPostgresEnabled, pingPostgres } from "../db/pg.ts";
import { enqueueAnalyzeJob, getJob } from "../jobs/queue.ts";
import { startAnalyzeWorker } from "../jobs/worker.ts";
import { countMissingExtracts } from "../db/extractCache.ts";
import { loadParsedTranscripts } from "../ingest/run.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function serveStatic(reqUrl: string, res: import("node:http").ServerResponse) {
  const path = reqUrl === "/" ? "/index.html" : reqUrl.split("?")[0];
  const file = join(PUBLIC_DIR, path);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = extname(file);
  const headers = { "Content-Type": MIME[ext] ?? "application/octet-stream" };
  if (ext === ".html") headers["Cache-Control"] = "no-store";
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}

export function startServer(port = PORT) {
  if (ENABLE_ANALYZE_WORKER && WORKER_CONCURRENCY > 0) {
    startAnalyzeWorker();
  } else {
    console.log(
      `[api] analyze worker disabled (ENABLE_ANALYZE_WORKER=${ENABLE_ANALYZE_WORKER} WORKER_CONCURRENCY=${WORKER_CONCURRENCY}) — run \`npm run worker\` separately`
    );
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const { pathname } = url;

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      if (req.method === "GET" && pathname === "/v1/stocks") {
        const symbols = await listAvailableStocks();
        sendJson(res, 200, { symbols, count: symbols.length });
        return;
      }

      const stockMatch = pathname.match(/^\/v1\/stocks\/([A-Za-z0-9._-]+)$/);
      if (req.method === "GET" && stockMatch) {
        const stock = await getStock(stockMatch[1]);
        if (stock.status === "not_found") {
          sendJson(res, 404, { symbol: stock.symbol, status: "not_found", error: "not_found" });
          return;
        }
        const payload = stockToUiPayload(stock);
        try {
          const { pricesForQuarters } = await import("../market/prices.ts");
          const txs = (payload.transcripts as Array<{ fyQuarter?: string; callDate?: string }>) || [];
          const quarterPrices = await pricesForQuarters(
            stock.symbol,
            txs.map((t) => ({ quarter: t.fyQuarter || "", callDate: t.callDate || "" }))
          );
          sendJson(res, 200, { ...payload, quarterPrices });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[api] prices enrich failed: ${msg}`);
          sendJson(res, 200, { ...payload, quarterPrices: [] });
        }
        return;
      }

      const jobMatch = pathname.match(/^\/v1\/jobs\/(\d+)$/);
      if (req.method === "GET" && jobMatch) {
        const job = getJob(Number(jobMatch[1]));
        if (!job) {
          sendJson(res, 404, { error: "job_not_found" });
          return;
        }
        sendJson(res, 200, job);
        return;
      }

      const refreshMatch = pathname.match(/^\/refresh\/([A-Za-z0-9._-]+)$/);
      if (req.method === "POST" && refreshMatch) {
        const force = url.searchParams.get("force") === "1";
        const result = await refreshSymbol(refreshMatch[1], { forceReparse: force });
        sendJson(res, 200, result);
        return;
      }

      const analyzeMatch = pathname.match(/^\/analyze\/([A-Za-z0-9._-]+)$/);
      if (req.method === "POST" && analyzeMatch) {
        const force = url.searchParams.get("force") === "1";
        const asyncMode = url.searchParams.get("async") === "1";
        if (asyncMode) {
          const job = enqueueAnalyzeJob(analyzeMatch[1], { force });
          sendJson(res, 202, {
            jobId: job.id,
            symbol: job.symbol,
            status: job.status,
            message: "queued — poll GET /v1/jobs/:id",
          });
          return;
        }
        const result = await analyzeSymbol(analyzeMatch[1], { force });
        sendJson(res, 200, result);
        return;
      }

      const getMatch = pathname.match(/^\/analysis\/([A-Za-z0-9._-]+)$/);
      if (req.method === "GET" && getMatch) {
        const cached = await getAnalysis(getMatch[1]);
        if (!cached) {
          sendJson(res, 404, { error: "not_cached", symbol: getMatch[1].toUpperCase() });
          return;
        }
        const missing = countMissingExtracts(loadParsedTranscripts(getMatch[1]));
        sendJson(res, 200, { ...cached, missingExtracts: missing });
        return;
      }

      if (req.method === "GET" && pathname === "/health") {
        const pgOk = isPostgresEnabled() ? await pingPostgres() : false;
        sendJson(res, 200, { ok: true, postgres: pgOk, usePostgres: isPostgresEnabled() });
        return;
      }

      if (req.method === "GET") {
        serveStatic(pathname, res);
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[api] error ${message}`);
      sendJson(res, 500, { error: message });
    }
  });

  server.listen(port, () => {
    console.log(`[api] listening on http://localhost:${port}`);
    console.log(
      `[api] GET /v1/stocks  GET /v1/stocks/:symbol  POST /refresh/:symbol  POST /analyze/:symbol[?async=1]  GET /v1/jobs/:id`
    );
    console.log(`[api] USE_POSTGRES=${isPostgresEnabled()}`);
  });
  return server;
}
