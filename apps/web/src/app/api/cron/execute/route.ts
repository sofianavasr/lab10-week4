import { NextResponse } from "next/server";
import { CronExpressionParser } from "cron-parser";
import { createServerClient } from "@agents/db";
import {
  getActiveCronjobs,
  updateLastExecutedAt,
  deactivateCronjob,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import { decrypt } from "@/lib/crypto";
import type { Cronjob } from "@agents/types";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CRON_SECRET = process.env.CRON_SECRET ?? "";

async function sendTelegramMessage(
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>
) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error("[cron/execute] sendTelegramMessage failed:", res.status, body);
  }
}

async function fetchUserContext(
  db: ReturnType<typeof createServerClient>,
  userId: string
) {
  const { data: profile } = await db
    .from("profiles")
    .select("agent_system_prompt")
    .eq("id", userId)
    .single();

  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", userId);

  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");

  let githubToken: string | undefined;
  const ghIntegration = (integrations ?? []).find(
    (i: Record<string, unknown>) => i.provider === "github"
  );
  if (ghIntegration?.encrypted_tokens) {
    try {
      githubToken = decrypt(ghIntegration.encrypted_tokens as string);
    } catch {
      // decryption failed
    }
  }

  let notionToken: string | undefined;
  const notionIntegration = (integrations ?? []).find(
    (i: Record<string, unknown>) => i.provider === "notion"
  );
  if (notionIntegration?.encrypted_tokens) {
    try {
      const decrypted = decrypt(notionIntegration.encrypted_tokens as string);
      const parsed = JSON.parse(decrypted) as { access_token?: string };
      notionToken = parsed.access_token;
    } catch {
      // decryption/parsing failed
    }
  }

  return {
    profile,
    toolSettings: toolSettings ?? [],
    integrations: integrations ?? [],
    githubToken,
    notionToken,
  };
}

function isCronjobDue(job: Cronjob): boolean {
  let interval;
  try {
    const now = new Date();
    // Floor to the current minute boundary
    const minuteStart = new Date(now);
    minuteStart.setSeconds(0, 0);

    const minuteEnd = new Date(minuteStart.getTime() + 60_000);

    // Parse without endDate — let next() return freely, then compare manually.
    // Passing endDate caused cron-parser to throw "Out of the time span range"
    // whenever the expression doesn't fire within the window, which is normal
    // behaviour for most minutes of the day.
    interval = CronExpressionParser.parse(job.expression, {
      currentDate: new Date(minuteStart.getTime() - 1),
    });

    const nextFire = interval.next().toDate();
    if (nextFire < minuteEnd) {
      // Expression fires this minute — check it hasn't already been executed this minute
      if (!job.last_executed_at) return true;
      return new Date(job.last_executed_at) < minuteStart;
    }
    return false;
  } catch (err) {
    // Only log truly invalid expressions, not normal "not due" cases
    console.error(`[cron/execute] Invalid cron expression "${job.expression}":`, err);
    return false;
  }
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();

  let jobs: Cronjob[];
  try {
    jobs = await getActiveCronjobs(db);
  } catch (err) {
    console.error("[cron/execute] Failed to fetch cronjobs:", err);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  const dueJobs = jobs.filter(isCronjobDue);

  if (dueJobs.length === 0) {
    return NextResponse.json({ ok: true, executed: 0 });
  }

  const results = await Promise.allSettled(
    dueJobs.map(async (job) => {
      // Find the user's Telegram chat_id
      const { data: telegramAccount } = await db
        .from("telegram_accounts")
        .select("chat_id")
        .eq("user_id", job.user_id)
        .single();

      const chatId = telegramAccount?.chat_id as number | undefined;

      // Get or create an active Telegram session for the user
      let session = await db
        .from("agent_sessions")
        .select("*")
        .eq("user_id", job.user_id)
        .eq("channel", "telegram")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .single()
        .then((r) => r.data);

      if (!session) {
        const { data } = await db
          .from("agent_sessions")
          .insert({
            user_id: job.user_id,
            channel: "telegram",
            status: "active",
            budget_tokens_used: 0,
            budget_tokens_limit: 100000,
          })
          .select()
          .single();
        session = data;
      }

      if (!session) {
        console.error(`[cron/execute] Could not get/create session for user ${job.user_id}`);
        return;
      }

      const ctx = await fetchUserContext(db, job.user_id);

      const result = await runAgent({
        message: job.description,
        userId: job.user_id,
        sessionId: session.id,
        systemPrompt: (ctx.profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
        db,
        enabledTools: ctx.toolSettings.map((t) => ({
          id: t.id as string,
          user_id: t.user_id as string,
          tool_id: t.tool_id as string,
          enabled: t.enabled as boolean,
          config_json: (t.config_json as Record<string, unknown>) ?? {},
        })),
        integrations: ctx.integrations.map((i) => ({
          id: i.id as string,
          user_id: i.user_id as string,
          provider: i.provider as string,
          scopes: (i.scopes as string[]) ?? [],
          status: i.status as "active" | "revoked" | "expired",
          created_at: i.created_at as string,
        })),
        githubToken: ctx.githubToken,
        notionToken: ctx.notionToken,
      });

      await updateLastExecutedAt(db, job.id);
      if (job.run_once) {
        await deactivateCronjob(db, job.id);
      }

      if (chatId) {
        if (result.pendingConfirmation) {
          await sendTelegramMessage(
            chatId,
            `[Tarea programada: ${job.jobname}]\n\n${result.pendingConfirmation.message}`,
            {
              inline_keyboard: [
                [
                  {
                    text: "Aprobar",
                    callback_data: `approve:${result.pendingConfirmation.tool_call_id}`,
                  },
                  {
                    text: "Cancelar",
                    callback_data: `reject:${result.pendingConfirmation.tool_call_id}`,
                  },
                ],
              ],
            }
          );
        } else {
          await sendTelegramMessage(
            chatId,
            `[Tarea programada: ${job.jobname}]\n\n${result.response}`
          );
        }
      }
    })
  );

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    failures.forEach((f) => {
      if (f.status === "rejected") {
        console.error("[cron/execute] Job failed:", f.reason);
      }
    });
  }

  return NextResponse.json({ ok: true, executed: dueJobs.length, failures: failures.length });
}
