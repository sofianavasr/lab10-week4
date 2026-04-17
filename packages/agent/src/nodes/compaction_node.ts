import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  RemoveMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { GraphState } from "../state";
import { createCompactionModel } from "../model";
import { appendCompactionLog, previewText } from "../compaction_logger";

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Conservative character-per-token ratio for heuristic window estimation.
 * We use 4 chars/token (Anthropic averages ~3.5) for a built-in safety margin.
 */
const CHARS_PER_TOKEN = 4;

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** Trigger LLM compaction when history exceeds this fraction of the window. */
const COMPACTION_THRESHOLD = 0.8;

/** Recent ToolMessages to keep intact during microcompact. */
const MICROCOMPACT_KEEP_RECENT = 5;

/** Tail of messages to preserve verbatim after LLM compaction for continuity. */
const COMPACTION_TAIL_SIZE = MICROCOMPACT_KEEP_RECENT * 2;

/** Stop retrying LLM compaction after this many consecutive failures. */
const CIRCUIT_BREAKER_LIMIT = 3;

function getContextWindowTokens(): number {
  const raw = process.env.AGENT_CONTEXT_WINDOW_TOKENS;
  if (!raw) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function estimateTokens(messages: BaseMessage[]): number {
  const totalChars = messages.reduce((acc, msg) => {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    return acc + content.length;
  }, 0);
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

function occupancyRatio(messages: BaseMessage[]): number {
  return estimateTokens(messages) / getContextWindowTokens();
}

/** Remove <analysis>…</analysis> blocks that models occasionally prepend. */
function stripAnalysisBlock(text: string): string {
  return text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
}

function replaceAllMessages(messages: BaseMessage[]): BaseMessage[] {
  return [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...messages];
}

// ─── Stage 1: Microcompact ─────────────────────────────────────────────────

/**
 * Replaces ToolMessage content with "[tool result cleared]" for old results,
 * preserving the most recent `MICROCOMPACT_KEEP_RECENT` tool results intact.
 * Preserves tool_call_id, optional name, and id so messagesStateReducer can match.
 */
type MicrocompactCleared = {
  index: number;
  tool_call_id: string;
  name?: string;
  beforePreview: string;
};

function microcompact(messages: BaseMessage[]): {
  messages: BaseMessage[];
  cleared: MicrocompactCleared[];
} {
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] instanceof ToolMessage) {
      toolIndices.push(i);
    }
  }

  const keepFrom = Math.max(0, toolIndices.length - MICROCOMPACT_KEEP_RECENT);
  const indicesToClear = new Set(toolIndices.slice(0, keepFrom));

  const cleared: MicrocompactCleared[] = [];

  const out = messages.map((msg, idx) => {
    if (!indicesToClear.has(idx)) return msg;
    const tm = msg as ToolMessage;
    const raw =
      typeof tm.content === "string"
        ? tm.content
        : JSON.stringify(tm.content);
    cleared.push({
      index: idx,
      tool_call_id: tm.tool_call_id,
      ...(tm.name != null ? { name: tm.name } : {}),
      beforePreview: previewText(raw, 800),
    });
    return new ToolMessage({
      content: "[tool result cleared]",
      tool_call_id: tm.tool_call_id,
      ...(tm.name != null ? { name: tm.name } : {}),
      ...(msg.id != null ? { id: msg.id } : {}),
    });
  });

  return { messages: out, cleared };
}

// ─── Stage 2: LLM Compaction ─────────────────────────────────────────────────

const COMPACTION_PROMPT = `You are a context compactor. Your task is to summarize a conversation into a structured context block that preserves all information the agent needs to continue working correctly.

Produce a structured summary with exactly these 9 sections:

1. **Goal**: The user's primary objective in this conversation.
2. **Progress**: What has been accomplished so far (tools called, files changed, issues created, etc.).
3. **Current State**: The precise state of the work right now (what is done, what is pending).
4. **Key Decisions**: Important choices made during the conversation and the rationale behind them.
5. **Constraints & Requirements**: Rules, limitations, or requirements the agent must respect.
6. **Tool Calls Summary**: A concise record of tools invoked and their outcomes.
7. **Open Questions**: Unresolved questions or ambiguities that may affect next steps.
8. **Next Steps**: What the agent should do next to continue progressing toward the goal.
9. **User Preferences**: Tone, language, style, or other preferences the user has expressed.

Rules:
- Be dense and precise. Omit pleasantries, verbose explanations, and filler.
- Preserve exact values (IDs, file paths, repo names, dates, cron expressions, etc.).
- Do NOT include an <analysis> block.
- Output only the 9-section summary, nothing else.`;

async function llmCompact(
  messages: BaseMessage[],
  logCtx?: { sessionId: string; userId: string }
): Promise<string> {
  const model = createCompactionModel();

  const transcript = messages
    .filter((m) => !(m instanceof SystemMessage))
    .map((m) => {
      const role =
        m instanceof HumanMessage
          ? "Human"
          : m instanceof AIMessage
            ? "Assistant"
            : m instanceof ToolMessage
              ? `Tool[${m.tool_call_id}]`
              : "System";
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}]: ${content}`;
    })
    .join("\n\n");

  if (logCtx) {
    await appendCompactionLog(
      [
        `LLM COMPACTION — llamada al modelo`,
        `sessionId=${logCtx.sessionId} userId=${logCtx.userId}`,
        `modelo=${process.env.COMPACTION_MODEL ?? "anthropic/claude-3-5-haiku-20241022"}`,
        `mensajes de entrada (sin SystemMessage inicial del compactor): ${messages.filter((m) => !(m instanceof SystemMessage)).length}`,
        `transcript: ${transcript.length} caracteres`,
        `--- ANTES (inicio del transcript) ---`,
        previewText(transcript, 4000),
      ].join("\n")
    );
  }

  const response = await model.invoke([
    new SystemMessage(COMPACTION_PROMPT),
    new HumanMessage(
      `Conversation to summarize:\n\n${transcript}\n\nProvide the structured 9-section summary now.`
    ),
  ]);

  const raw =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  const summary = stripAnalysisBlock(raw);

  if (logCtx) {
    await appendCompactionLog(
      [
        `LLM COMPACTION — respuesta del modelo`,
        `sessionId=${logCtx.sessionId}`,
        `--- DESPUÉS (resumen generado, ${summary.length} caracteres) ---`,
        previewText(summary, 6000),
      ].join("\n")
    );
  }

  return summary;
}

// ─── Node ───────────────────────────────────────────────────────────────────

export async function compactionNode(
  state: typeof GraphState.State
): Promise<Partial<typeof GraphState.State>> {
  const { messages, systemPrompt, compactionCount: prevSuccessCount } = state;
  const prevStreak = state.compactionFailureStreak ?? 0;
  const sessionId = state.sessionId ?? "(unknown-session)";
  const userId = state.userId ?? "(unknown-user)";

  // ── Stage 1: Microcompact (always runs, zero cost) ───────────────────────
  const { messages: afterMicro, cleared } = microcompact(messages);

  const ratioBefore = occupancyRatio(messages);
  const ratioAfterMicro = occupancyRatio(afterMicro);

  const clearedLines =
    cleared.length === 0
      ? "(ningún ToolMessage antiguo sustituido; los más recientes se conservan íntegros)"
      : cleared
          .map(
            (c) =>
              `  [índice ${c.index}] tool_call_id=${c.tool_call_id}${c.name != null ? ` name=${c.name}` : ""}\n    ANTES: ${c.beforePreview}\n    DESPUÉS: [tool result cleared]`
          )
          .join("\n");

  await appendCompactionLog(
    [
      `MICROCOMPACT — ofuscación / limpieza de resultados de tools`,
      `sessionId=${sessionId} userId=${userId}`,
      `mensajes totales: ${messages.length} → ${afterMicro.length} (misma longitud de lista)`,
      `ocupación estimada (chars/token): ${(ratioBefore * 100).toFixed(2)}% → ${(ratioAfterMicro * 100).toFixed(2)}% del contexto`,
      `ToolMessages con contenido reemplazado por placeholder: ${cleared.length}`,
      `--- Detalle (antes → después por tool) ---`,
      clearedLines,
    ].join("\n")
  );

  // ── Circuit breaker: skip LLM compaction after repeated failures ─────────
  if (prevStreak >= CIRCUIT_BREAKER_LIMIT) {
    await appendCompactionLog(
      [
        `LLM COMPACTION — omitido (circuit breaker)`,
        `sessionId=${sessionId}`,
        `compactionFailureStreak=${prevStreak} (límite ${CIRCUIT_BREAKER_LIMIT})`,
      ].join("\n")
    );
    return {
      messages: replaceAllMessages(afterMicro),
      compactionFailureStreak: prevStreak,
    };
  }

  // ── Stage 2: LLM compaction (only if above threshold) ────────────────────
  const ratio = occupancyRatio(afterMicro);
  if (ratio < COMPACTION_THRESHOLD) {
    await appendCompactionLog(
      [
        `LLM COMPACTION — no invocado (por debajo del umbral)`,
        `sessionId=${sessionId}`,
        `ratio tras microcompact=${(ratio * 100).toFixed(2)}% < umbral ${(COMPACTION_THRESHOLD * 100).toFixed(0)}%`,
      ].join("\n")
    );
    return {
      messages: replaceAllMessages(afterMicro),
      compactionFailureStreak: 0,
    };
  }

  const tail = afterMicro.slice(-COMPACTION_TAIL_SIZE);
  const toSummarize = afterMicro.slice(
    0,
    Math.max(0, afterMicro.length - tail.length)
  );

  const first = afterMicro[0];
  const preservedSystem =
    first instanceof SystemMessage
      ? first
      : new SystemMessage(systemPrompt);

  const logCtx = { sessionId, userId };

  try {
    await appendCompactionLog(
      [
        `LLM COMPACTION — invocado (historia por encima del umbral)`,
        `sessionId=${sessionId}`,
        `ratio=${(ratio * 100).toFixed(2)}% | tail preservado=${tail.length} msgs | bloque a resumir=${toSummarize.length} msgs`,
      ].join("\n")
    );

    const summary =
      toSummarize.length > 0
        ? await llmCompact(toSummarize, logCtx)
        : await llmCompact(afterMicro, logCtx);

    const summaryMsg = new SystemMessage(
      `[CONTEXT SUMMARY — previous conversation compacted]\n\n${summary}`
    );

    await appendCompactionLog(
      [
        `LLM COMPACTION — estado final del nodo`,
        `sessionId=${sessionId}`,
        `compactionCount: ${(prevSuccessCount ?? 0) + 1}`,
        `historia reemplazada por: System (original/preserved) + System(resumen) + tail (${tail.length} mensajes)`,
      ].join("\n")
    );

    return {
      messages: replaceAllMessages([preservedSystem, summaryMsg, ...tail]),
      compactionFailureStreak: 0,
      compactionCount: (prevSuccessCount ?? 0) + 1,
    };
  } catch (err) {
    await appendCompactionLog(
      [
        `LLM COMPACTION — error (se mantiene solo microcompact)`,
        `sessionId=${sessionId}`,
        `compactionFailureStreak: ${prevStreak} → ${prevStreak + 1}`,
        String(err instanceof Error ? err.stack ?? err.message : err),
      ].join("\n")
    );
    return {
      messages: replaceAllMessages(afterMicro),
      compactionFailureStreak: prevStreak + 1,
    };
  }
}

/** Exported for tests; same behavior as internal `microcompact`. */
export function microcompactToolResults(messages: BaseMessage[]): BaseMessage[] {
  return microcompact(messages).messages;
}
