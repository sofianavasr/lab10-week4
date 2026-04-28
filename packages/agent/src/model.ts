import { ChatOpenAI } from "@langchain/openai";
import { OpenAIEmbeddings } from "@langchain/openai";

const openRouterConfig = {
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://agents.local",
  },
} as const;

export function createChatModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  return new ChatOpenAI({
    modelName: "openai/gpt-4o-mini",
    temperature: 0.3,
    configuration: openRouterConfig,
    apiKey,
  });
}

/** Haiku on OpenRouter — mechanical summarization for history compaction. */
export function createCompactionModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const modelName =
    process.env.COMPACTION_MODEL ?? "openai/gpt-4o-mini";

  return new ChatOpenAI({
    modelName,
    temperature: 0,
    configuration: openRouterConfig,
    apiKey,
  });
}

export function createMemoryExtractionModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const modelName = process.env.MEMORY_EXTRACTION_MODEL ?? "openai/gpt-4o-mini";

  return new ChatOpenAI({
    modelName,
    temperature: 0,
    configuration: openRouterConfig,
    apiKey,
  });
}

export function createEmbeddingModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  return new OpenAIEmbeddings({
    model: "openai/text-embedding-3-small",
    dimensions: 1536,
    apiKey,
    configuration: openRouterConfig,
  });
}
