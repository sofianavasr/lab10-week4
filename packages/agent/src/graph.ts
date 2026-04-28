import { StateGraph, Command } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration, PendingConfirmation } from "@agents/types";
import { createChatModel } from "./model";
import { buildLangChainTools } from "./tools/adapters";
import { getSessionMessages, addMessage } from "@agents/db";
import { GraphState } from "./state";
import { compactionNode } from "./nodes/compaction_node";
import { createMemoryInjectionNode } from "./nodes/memory_injection_node";

export interface AgentInput {
  message: string;
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  notionToken?: string;
  resumeAction?: "approve" | "reject";
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation?: PendingConfirmation;
}

const MAX_TOOL_ITERATIONS = 6;

// Track the thread_id used for interrupted sessions so resume can find the checkpoint
const interruptedThreadIds = new Map<string, string>();

let _checkpointerPromise: Promise<PostgresSaver> | null = null;

function getCheckpointer(): Promise<PostgresSaver> {
  if (!_checkpointerPromise) {
    _checkpointerPromise = (async () => {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) throw new Error("DATABASE_URL is required for checkpoint persistence");
      const saver = PostgresSaver.fromConnString(dbUrl);
      await saver.setup();
      return saver;
    })();
  }
  return _checkpointerPromise;
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const {
    message,
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    githubToken,
    notionToken,
    resumeAction,
  } = input;

  const model = createChatModel();
  const lcTools = buildLangChainTools({
    db,
    userId,
    sessionId,
    enabledTools,
    integrations,
    githubToken,
    notionToken,
  });

  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;
  const memoryInjectionNode = createMemoryInjectionNode(db);

  const toolCallNames: string[] = [];

  async function agentNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  }

  async function toolExecutorNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!(lastMsg instanceof AIMessage) || !lastMsg.tool_calls?.length) {
      return {};
    }

    const { ToolMessage } = await import("@langchain/core/messages");
    const results: BaseMessage[] = [];
    for (const tc of lastMsg.tool_calls) {
      const matchingTool = lcTools.find((t) => t.name === tc.name);
      toolCallNames.push(tc.name);
      if (matchingTool) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (matchingTool as any).invoke(tc.args);
        const resultStr = String(result);
        results.push(new ToolMessage({ content: resultStr, tool_call_id: tc.id! }));
      }
    }
    return { messages: results };
  }

  function shouldContinue(state: typeof GraphState.State): string {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      const iterations = state.messages.filter(
        (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length
      ).length;
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    return "end";
  }

  const graph = new StateGraph(GraphState)
    .addNode("memory_injection", memoryInjectionNode)
    .addNode("compaction", compactionNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "memory_injection")
    .addEdge("memory_injection", "compaction")
    .addEdge("compaction", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: "__end__",
    })
    .addEdge("tools", "compaction");

  const checkpointer = await getCheckpointer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = graph.compile({ checkpointer: checkpointer as any });

  // For resume: use the stored thread_id from the interrupted invocation.
  // For new messages: use a unique thread_id so stale checkpoint state isn't merged
  // with DB-reconstructed messages (which lack tool_calls metadata).
  const threadId = resumeAction
    ? (interruptedThreadIds.get(sessionId) ?? sessionId)
    : `${sessionId}-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  if (resumeAction) {
    interruptedThreadIds.delete(sessionId);

    const finalState = await app.invoke(
      new Command({ resume: resumeAction }),
      config
    );

    const snapshot = await app.getState(config);
    const interrupted = snapshot.tasks.some(
      (t) => t.interrupts && t.interrupts.length > 0
    );

    if (interrupted) {
      const interruptValue = snapshot.tasks
        .flatMap((t) => t.interrupts ?? [])
        .find((i) => i.value)?.value as PendingConfirmation | undefined;

      if (interruptValue) {
        interruptedThreadIds.set(sessionId, threadId);
        await addMessage(db, sessionId, "assistant", interruptValue.message);
        return {
          response: interruptValue.message,
          toolCalls: toolCallNames,
          pendingConfirmation: interruptValue,
        };
      }
    }

    const lastMessage = finalState.messages[finalState.messages.length - 1];
    const responseText =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);

    await addMessage(db, sessionId, "assistant", responseText);
    return { response: responseText, toolCalls: toolCallNames };
  }

  const history = await getSessionMessages(db, sessionId, 30);
  const priorMessages: BaseMessage[] = history.map((m) => {
    if (m.role === "user") return new HumanMessage(m.content);
    if (m.role === "assistant") return new AIMessage(m.content);
    return new HumanMessage(m.content);
  });

  await addMessage(db, sessionId, "user", message);

  const currentDate = new Date().toLocaleDateString("es-ES", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const fullSystemPrompt = `${systemPrompt}\n\nFecha actual: ${currentDate}.`;

  const initialMessages: BaseMessage[] = [
    new SystemMessage(fullSystemPrompt),
    ...priorMessages,
    new HumanMessage(message),
  ];

  const finalState = await app.invoke(
    {
      messages: initialMessages,
      sessionId,
      userId,
      systemPrompt,
      compactionCount: 0,
      compactionFailureStreak: 0,
    },
    config
  );

  const snapshot = await app.getState(config);
  const interrupted = snapshot.tasks.some(
    (t) => t.interrupts && t.interrupts.length > 0
  );

  if (interrupted) {
    const interruptValue = snapshot.tasks
      .flatMap((t) => t.interrupts ?? [])
      .find((i) => i.value)?.value as PendingConfirmation | undefined;

    if (interruptValue) {
      interruptedThreadIds.set(sessionId, threadId);
      await addMessage(db, sessionId, "assistant", interruptValue.message);
      return {
        response: interruptValue.message,
        toolCalls: toolCallNames,
        pendingConfirmation: interruptValue,
      };
    }
  }

  const lastMessage = finalState.messages[finalState.messages.length - 1];
  const responseText =
    typeof lastMessage.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

  await addMessage(db, sessionId, "assistant", responseText);

  return { response: responseText, toolCalls: toolCallNames };
}

export async function resumeAgent(input: AgentInput): Promise<AgentOutput> {
  return runAgent(input);
}
