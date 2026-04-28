import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import { getSessionMessages, insertMemories } from "@agents/db";
import type { MemoryType } from "@agents/types";
import { createEmbeddingModel, createMemoryExtractionModel } from "./model";

type ExtractedMemory = {
  type: MemoryType;
  content: string;
};

const LOG_PREFIX = "[memory_flush]";

function preview(text: string, max = 500): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

const EXTRACTION_PROMPT = `Eres un extractor conservador de memoria de largo plazo para un agente.

Extrae solo recuerdos que probablemente sigan siendo verdad en la siguiente sesion:
- semantic: preferencias estables o conocimiento durable del usuario.
- procedural: como prefiere trabajar el usuario, reglas operativas recurrentes.
- episodic: hechos concretos importantes de trabajo reciente (que, cuando, resultado), solo si son utiles para continuidad.

Reglas estrictas:
- NO incluyas charla trivial, saludos, cortesias o small talk.
- NO incluyas solicitudes puntuales que no tendran valor futuro.
- NO inventes nada.
- Resume cada recuerdo en una frase breve y autocontenida.
- Si no hay recuerdos utiles, responde un arreglo JSON vacio [].
- Responde SOLO JSON valido con este formato:
[
  { "type": "episodic|semantic|procedural", "content": "..." }
]`;

function toTranscript(messages: BaseMessage[]): string {
  return messages
    .map((m) => {
      const role =
        m instanceof HumanMessage ? "user" : m instanceof AIMessage ? "assistant" : "other";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}] ${content}`;
    })
    .join("\n");
}

function parseExtractionJson(raw: string): ExtractedMemory[] {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end < 0 || end < start) {
    console.info(`${LOG_PREFIX} no JSON array delimiters in model output`, {
      rawChars: raw.length,
      preview: preview(raw, 400),
    });
    return [];
  }

  const candidate = trimmed.slice(start, end + 1);
  const parsed = JSON.parse(candidate) as unknown;
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item): item is { type: string; content: string } => {
      return (
        typeof item === "object" &&
        item !== null &&
        typeof (item as { type?: unknown }).type === "string" &&
        typeof (item as { content?: unknown }).content === "string"
      );
    })
    .map((item) => ({
      type: item.type as MemoryType,
      content: item.content.trim(),
    }))
    .filter(
      (item) =>
        item.content.length > 0 &&
        (item.type === "episodic" ||
          item.type === "semantic" ||
          item.type === "procedural")
    );
}

export async function flushSessionMemories(params: {
  db: DbClient;
  userId: string;
  sessionId: string;
}) {
  const { db, userId, sessionId } = params;
  console.info(`${LOG_PREFIX} start`, { userId, sessionId });

  const rows = await getSessionMessages(db, sessionId, 200);
  console.info(`${LOG_PREFIX} loaded agent_messages`, {
    sessionId,
    count: rows.length,
    roles: rows.reduce(
      (acc, m) => {
        acc[m.role] = (acc[m.role] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    ),
  });

  if (rows.length === 0) {
    console.info(`${LOG_PREFIX} skip: no messages in session`, { sessionId });
    return { inserted: 0 };
  }

  const messages: BaseMessage[] = rows.map((m) =>
    m.role === "assistant" ? new AIMessage(m.content) : new HumanMessage(m.content)
  );

  const extractionModel = createMemoryExtractionModel();
  const embeddingModel = createEmbeddingModel();

  const transcript = toTranscript(messages);
  console.info(`${LOG_PREFIX} calling extraction model`, {
    sessionId,
    transcriptChars: transcript.length,
  });

  const response = await extractionModel.invoke([
    new HumanMessage(`${EXTRACTION_PROMPT}\n\nTranscripcion:\n${transcript}`),
  ]);

  const raw = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
  console.info(`${LOG_PREFIX} extraction model raw response`, {
    sessionId,
    rawChars: raw.length,
    preview: preview(raw, 600),
  });

  let extracted: ExtractedMemory[] = [];
  try {
    extracted = parseExtractionJson(raw);
  } catch (err) {
    console.error(`${LOG_PREFIX} JSON parse failed`, {
      sessionId,
      preview: preview(raw, 800),
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (extracted.length === 0) {
    console.info(`${LOG_PREFIX} no memories after parse/filter (model returned nothing usable)`, {
      sessionId,
    });
    return { inserted: 0 };
  }

  console.info(`${LOG_PREFIX} extracted memories (pre-embed)`, {
    sessionId,
    count: extracted.length,
    types: extracted.map((m) => m.type),
    contentPreview: extracted.map((m) => preview(m.content, 120)),
  });

  const records = await Promise.all(
    extracted.map(async (memory) => ({
      user_id: userId,
      type: memory.type,
      content: memory.content,
      embedding: await embeddingModel.embedQuery(memory.content),
    }))
  );

  await insertMemories(db, records);
  console.info(`${LOG_PREFIX} inserted into memories`, {
    sessionId,
    inserted: records.length,
  });
  return { inserted: records.length };
}
