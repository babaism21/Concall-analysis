import OpenAI from "openai";
import { MODEL_ID, OPENROUTER_BASE_URL } from "./config.ts";

/** Per-request timeout for OpenRouter (ms). Synthesis can be slow; fail rather than hang forever. */
const LLM_TIMEOUT_MS = Math.max(30_000, Number(process.env.LLM_TIMEOUT_MS ?? 180_000));

export function getLlmClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set (see .env.example)");
  }
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    timeout: LLM_TIMEOUT_MS,
    maxRetries: 2,
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/babaism21/Concall-analysis",
      "X-Title": "Concall Analysis",
    },
  });
}

export { MODEL_ID };
