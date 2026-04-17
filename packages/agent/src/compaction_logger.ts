import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Ruta del .log; por defecto `agent-compaction.log` en el cwd del proceso. */
export function getCompactionLogPath(): string {
  const fromEnv = process.env.AGENT_COMPACTION_LOG?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(process.cwd(), "agent-compaction.log");
}

function disabled(): boolean {
  return process.env.AGENT_COMPACTION_LOG === "0";
}

export async function appendCompactionLog(section: string): Promise<void> {
  if (disabled()) return;
  const file = getCompactionLogPath();
  const dir = dirname(file);
  if (dir && dir !== ".") {
    await mkdir(dir, { recursive: true });
  }
  const ts = new Date().toISOString();
  const block = `\n${"=".repeat(88)}\n[${ts}]\n${section.trimEnd()}\n`;
  await appendFile(file, block, "utf8");
}

export function previewText(text: string, maxLen = 500): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}… [+${t.length - maxLen} chars]`;
}
