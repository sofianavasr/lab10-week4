import { RemoveMessage, SystemMessage } from "@langchain/core/messages";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import type { DbClient } from "@agents/db";
import {
  bumpMemoryRetrieval,
  searchMemoriesBySimilarity,
} from "@agents/db";
import { GraphState } from "../state";
import { createEmbeddingModel } from "../model";

function buildMemoryBlock(
  memories: Array<{ type: string; content: string }>
): string {
  if (memories.length === 0) return "";
  const lines = memories.map((memory, idx) => {
    return `${idx + 1}. [${memory.type}] ${memory.content}`;
  });
  return `[MEMORIA DEL USUARIO]\n${lines.join("\n")}`;
}

function enrichPrompt(basePrompt: string, memoryBlock: string): string {
  if (!memoryBlock) return basePrompt;
  return `${basePrompt}\n\n${memoryBlock}`;
}

const LOG_PREFIX = "[memory_injection]";

function previewInput(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export function createMemoryInjectionNode(db: DbClient) {
  const embeddingModel = createEmbeddingModel();

  return async function memoryInjectionNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMessage = state.messages[state.messages.length - 1];
    const userInput =
      typeof lastMessage?.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage?.content ?? "");

    if (!state.userId || !userInput.trim()) {
      console.info(`${LOG_PREFIX} skip`, {
        reason: !state.userId ? "missing_userId" : "empty_user_input",
        sessionId: state.sessionId,
      });
      return {};
    }

    console.info(`${LOG_PREFIX} search`, {
      userId: state.userId,
      sessionId: state.sessionId,
      inputPreview: previewInput(userInput),
      inputChars: userInput.length,
    });

    const queryEmbedding = await embeddingModel.embedQuery(userInput);
    const memories = await searchMemoriesBySimilarity(
      db,
      state.userId,
      queryEmbedding,
      6
    );

    if (memories.length === 0) {
      console.info(`${LOG_PREFIX} no matches`, {
        userId: state.userId,
        sessionId: state.sessionId,
      });
      return {};
    }

    console.info(`${LOG_PREFIX} matches`, {
      userId: state.userId,
      sessionId: state.sessionId,
      count: memories.length,
      ids: memories.map((m) => m.id),
      similarities: memories.map((m) => m.similarity),
      types: memories.map((m) => m.type),
    });

    await bumpMemoryRetrieval(
      db,
      memories.map((m) => m.id)
    );

    console.info(`${LOG_PREFIX} bumped retrieval_count`, {
      memoryIds: memories.map((m) => m.id),
    });

    const memoryBlock = buildMemoryBlock(memories);
    const firstSystem = state.messages.find((m) => m instanceof SystemMessage);
    const basePrompt =
      firstSystem && typeof firstSystem.content === "string"
        ? firstSystem.content
        : (state.systemPrompt ?? "");
    const enrichedSystemPrompt = enrichPrompt(basePrompt, memoryBlock);
    const injectedSystem = new SystemMessage(enrichedSystemPrompt);
    const withoutSystem = state.messages.filter(
      (m) => !(m instanceof SystemMessage)
    );

    return {
      systemPrompt: enrichedSystemPrompt,
      messages: [
        new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
        injectedSystem,
        ...withoutSystem,
      ],
    };
  };
}
