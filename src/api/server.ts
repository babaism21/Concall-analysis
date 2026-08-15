import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { PORT, PUBLIC_DIR } from "../config.ts";
import { analyzeSymbol, getAnalysis } from "../analyze/run.ts";
import { refreshSymbol } from "../ingest/refresh.ts";
import { getStock, stockToUiPayload } from "./v1/stocks.ts";
import { isPostgresEnabled, pingPostgres } from "../db/pg.ts";

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
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

export function startServer(port = PORT) {
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

      const stockMatch = pathname.match(/^\/v1\/stocks\/([A-Za-z0-9._-]+)$/);
      if (req.method === "GET" && stockMatch) {
        const stock = await getStock(stockMatch[1]);
        if (stock.status === "not_found") {
          sendJson(res, 404, { symbol: stock.symbol, status: "not_found", error: "not_found" });
          return;
        }
        sendJson(res, 200, stockToUiPayload(stock));
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
        sendJson(res, 200, cached);
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
      `[api] GET /v1/stocks/:symbol  POST /refresh/:symbol  POST /analyze/:symbol  GET /analysis/:symbol`
    );
    console.log(`[api] USE_POSTGRES=${isPostgresEnabled()}`);
  });
  return server;
}
