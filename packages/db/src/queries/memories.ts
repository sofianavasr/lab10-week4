import type { DbClient } from "../client";
import type { Memory, MemoryType } from "@agents/types";

interface MemoryMatchRow extends Memory {
  similarity: number;
}

export async function insertMemories(
  db: DbClient,
  records: Array<{
    user_id: string;
    type: MemoryType;
    content: string;
    embedding: number[];
  }>
) {
  if (records.length === 0) return [] as Memory[];
  const { data, error } = await db.from("memories").insert(records).select("*");
  if (error) throw error;
  return (data ?? []) as Memory[];
}

export async function searchMemoriesBySimilarity(
  db: DbClient,
  userId: string,
  queryEmbedding: number[],
  limit = 6
) {
  const { data, error } = await db.rpc("match_memories", {
    p_user_id: userId,
    p_query_embedding: queryEmbedding,
    p_match_count: limit,
  });
  if (error) throw error;
  return (data ?? []) as MemoryMatchRow[];
}

export async function bumpMemoryRetrieval(
  db: DbClient,
  memoryIds: string[]
) {
  if (memoryIds.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await db.rpc("increment_memory_retrieval", {
    p_memory_ids: memoryIds,
    p_last_retrieved_at: now,
  });
  if (error) throw error;
}
