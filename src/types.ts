import type { PortfolioJson } from "./analyze/score.ts";

export type TranscriptPayload = {
  callDate: string;
  fyQuarter: string;
  sourceUrl: string;
  text: string;
  charCount: number;
};

export type AnalysisRecord = {
  symbol: string;
  markdown: string;
  portfolioJson: PortfolioJson;
  latestSourceUrl: string | null;
  transcriptCount: number;
  modelId: string | null;
  promptVersion: string | null;
  createdAt: string;
  updatedAt: string;
  cacheHit: boolean;
  source?: "db" | "example" | "fresh";
  updateAvailable?: boolean;
  transcripts?: TranscriptPayload[];
};
