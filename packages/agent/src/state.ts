import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

/**
 * Graph state: messages use LangGraph's reducer so compaction can replace history via
 * RemoveMessage(REMOVE_ALL_MESSAGES) + new list; other fields use last-write wins.
 */
export const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
  /** Increments on each successful LLM compaction. */
  compactionCount: Annotation<number>(),
  /** Consecutive LLM compaction failures; reset on success or microcompact-only pass. */
  compactionFailureStreak: Annotation<number>(),
});
