import OpenAI from "openai";
import { MODEL_ID, OPENROUTER_BASE_URL } from "./config.ts";

export function getLlmClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set (see .env.example)");
  }
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/babaism21/Concall-analysis",
      "X-Title": "Concall Analysis",
    },
  });
}

export { MODEL_ID };
