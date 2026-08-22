import {
  attachTranscriptAnchors,
  repairFlatTimeline,
  type PortfolioJson,
} from "../analyze/score.ts";
import type { AnalysisRecord } from "../types.ts";
import type { StockResponse } from "./pg.ts";

export function stockToAnalysisRecord(stock: StockResponse): AnalysisRecord | null {
  if (!stock.analysis) return null;

  const portfolioJson = repairFlatTimeline(
    attachTranscriptAnchors(stock.analysis.portfolioJson, stock.transcripts)
  );

  return {
    symbol: stock.symbol,
    markdown: stock.analysis.markdown,
    portfolioJson,
    latestSourceUrl: stock.analysis.latestSourceUrl,
    transcriptCount: stock.transcripts.length || stock.analysis.transcriptCount,
    modelId: stock.analysis.modelId,
    promptVersion: stock.analysis.promptVersion,
    createdAt: stock.analysis.createdAt,
    updatedAt: stock.analysis.updatedAt,
    cacheHit: true,
    source: "db",
    transcripts: stock.transcripts,
  };
}

export function stockToUiPayload(stock: StockResponse): Record<string, unknown> {
  const rec = stockToAnalysisRecord(stock);
  if (!rec) {
    return {
      symbol: stock.symbol,
      status: stock.status,
      transcripts: stock.transcripts,
      error: stock.status === "not_found" ? "not_found" : "analysis_missing",
    };
  }

  return {
    ...rec,
    status: stock.status,
  };
}

export function enrichPortfolioJson(
  portfolioJson: PortfolioJson,
  transcripts: StockResponse["transcripts"]
): PortfolioJson {
  return repairFlatTimeline(attachTranscriptAnchors(portfolioJson, transcripts));
}
