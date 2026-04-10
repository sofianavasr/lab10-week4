import { NextResponse } from "next/server";
import { createServerClient } from "@agents/db";
import { runAgent } from "@agents/agent";
import { decrypt } from "@/lib/crypto";
import { githubCreateIssue, githubCreateRepo } from "@/lib/github";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string };
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { chat: { id: number }; message_id: number };
    data: string;
  };
}

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
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Telegram sendMessage failed:", res.status, body);
  }
}

function parseBotCommand(messageText: string): { command: string; args: string } {
  const trimmed = messageText.trim();
  const i = trimmed.indexOf(" ");
  const head = i === -1 ? trimmed : trimmed.slice(0, i);
  const tail = i === -1 ? "" : trimmed.slice(i + 1).trim();
  const at = head.indexOf("@");
  const command = (at === -1 ? head : head.slice(0, at)).toLowerCase();
  return { command, args: tail };
}

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function executeToolCall(
  db: ReturnType<typeof createServerClient>,
  toolCall: Record<string, unknown>,
  userId: string
): Promise<string> {
  const { data: integration } = await db
    .from("user_integrations")
    .select("encrypted_tokens")
    .eq("user_id", userId)
    .eq("provider", "github")
    .eq("status", "active")
    .single();

  if (!integration?.encrypted_tokens) {
    return "Error: GitHub no está conectado.";
  }

  const token = decrypt(integration.encrypted_tokens as string);
  const args = toolCall.arguments_json as Record<string, unknown>;

  switch (toolCall.tool_name) {
    case "github_create_issue": {
      const issue = await githubCreateIssue(
        token,
        args.owner as string,
        args.repo as string,
        args.title as string,
        (args.body as string) ?? ""
      );
      await db
        .from("tool_calls")
        .update({
          status: "executed",
          result_json: { issue_url: issue.html_url, issue_number: issue.number },
          finished_at: new Date().toISOString(),
        })
        .eq("id", toolCall.id);
      return `Issue creado: ${issue.title}\n${issue.html_url}`;
    }
    case "github_create_repo": {
      const repo = await githubCreateRepo(
        token,
        args.name as string,
        (args.description as string) ?? "",
        (args.is_private as boolean) ?? false
      );
      await db
        .from("tool_calls")
        .update({
          status: "executed",
          result_json: { repo_url: repo.html_url },
          finished_at: new Date().toISOString(),
        })
        .eq("id", toolCall.id);
      return `Repositorio creado: ${repo.full_name}\n${repo.html_url}`;
    }
    default:
      return `Herramienta no soportada: ${toolCall.tool_name}`;
  }
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const update: TelegramUpdate = await request.json();
  const db = createServerClient();

  if (update.callback_query) {
    const cb = update.callback_query;
    const [action, toolCallId] = cb.data.split(":");

    if (action === "approve" && toolCallId) {
      const { data: toolCall } = await db
        .from("tool_calls")
        .select("*, agent_sessions!inner(user_id)")
        .eq("id", toolCallId)
        .eq("status", "pending_confirmation")
        .single();

      if (!toolCall) {
        await answerCallbackQuery(cb.id, "Ya fue procesado");
        return NextResponse.json({ ok: true });
      }

      const userId = (toolCall.agent_sessions as Record<string, unknown>).user_id as string;
      await answerCallbackQuery(cb.id, "Aprobado");
      await sendTelegramMessage(cb.message.chat.id, "Acción aprobada. Ejecutando...");

      try {
        const resultMsg = await executeToolCall(db, toolCall, userId);
        await sendTelegramMessage(cb.message.chat.id, resultMsg);
      } catch (err) {
        console.error("Tool execution error:", err);
        await db
          .from("tool_calls")
          .update({ status: "failed", finished_at: new Date().toISOString() })
          .eq("id", toolCallId);
        await sendTelegramMessage(cb.message.chat.id, "Error al ejecutar la acción.");
      }
    } else if (action === "reject" && toolCallId) {
      await db
        .from("tool_calls")
        .update({ status: "rejected", finished_at: new Date().toISOString() })
        .eq("id", toolCallId)
        .eq("status", "pending_confirmation");
      await answerCallbackQuery(cb.id, "Rechazado");
      await sendTelegramMessage(cb.message.chat.id, "Acción cancelada.");
    }

    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message?.text) {
    return NextResponse.json({ ok: true });
  }

  const telegramUserId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();
  const { command, args } = parseBotCommand(text);

  if (command === "/start") {
    await sendTelegramMessage(
      chatId,
      "¡Hola! Soy tu agente personal.\n\nSi ya tienes cuenta web, ve a Ajustes → Telegram en la web, genera un código de vinculación y envíamelo así:\n/link TU_CODIGO"
    );
    return NextResponse.json({ ok: true });
  }

  if (command === "/link") {
    const code = args.trim().toUpperCase();
    if (!code) {
      await sendTelegramMessage(
        chatId,
        "Indica el código que generaste en la web, por ejemplo:\n/link ABC123"
      );
      return NextResponse.json({ ok: true });
    }

    const { data: linkRecord } = await db
      .from("telegram_link_codes")
      .select("*")
      .eq("code", code)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (!linkRecord) {
      await sendTelegramMessage(chatId, "Código inválido o expirado. Genera uno nuevo desde la web.");
      return NextResponse.json({ ok: true });
    }

    await db.from("telegram_accounts").upsert(
      {
        user_id: linkRecord.user_id,
        telegram_user_id: telegramUserId,
        chat_id: chatId,
        linked_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    await db
      .from("telegram_link_codes")
      .update({ used: true })
      .eq("id", linkRecord.id);

    await sendTelegramMessage(chatId, "¡Cuenta vinculada correctamente! Ya puedes chatear conmigo.");
    return NextResponse.json({ ok: true });
  }

  const { data: telegramAccount } = await db
    .from("telegram_accounts")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .single();

  if (!telegramAccount) {
    await sendTelegramMessage(
      chatId,
      "No tienes una cuenta vinculada. Usa /link TU_CODIGO (código desde Ajustes en la web)."
    );
    return NextResponse.json({ ok: true });
  }

  const userId = telegramAccount.user_id;

  let session = await db
    .from("agent_sessions")
    .select("*")
    .eq("user_id", userId)
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
        user_id: userId,
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
    await sendTelegramMessage(chatId, "Error interno creando sesión.");
    return NextResponse.json({ ok: true });
  }

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
      // decryption failed, proceed without it
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
      // decryption/parsing failed, proceed without it
    }
  }

  try {
    const result = await runAgent({
      message: text,
      userId,
      sessionId: session.id,
      systemPrompt: profile?.agent_system_prompt ?? "Eres un asistente útil.",
      db,
      enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        user_id: t.user_id as string,
        tool_id: t.tool_id as string,
        enabled: t.enabled as boolean,
        config_json: (t.config_json as Record<string, unknown>) ?? {},
      })),
      integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
        id: i.id as string,
        user_id: i.user_id as string,
        provider: i.provider as string,
        scopes: (i.scopes as string[]) ?? [],
        status: i.status as "active" | "revoked" | "expired",
        created_at: i.created_at as string,
      })),
      githubToken,
      notionToken,
    });

    if (result.pendingConfirmation) {
      await sendTelegramMessage(
        chatId,
        result.pendingConfirmation.message,
        {
          inline_keyboard: [
            [
              { text: "Aprobar", callback_data: `approve:${result.pendingConfirmation.tool_call_id}` },
              { text: "Cancelar", callback_data: `reject:${result.pendingConfirmation.tool_call_id}` },
            ],
          ],
        }
      );
    } else {
      await sendTelegramMessage(chatId, result.response);
    }
  } catch (error) {
    console.error("Telegram agent error:", error);
    await sendTelegramMessage(chatId, "Hubo un error procesando tu mensaje. Intenta de nuevo.");
  }

  return NextResponse.json({ ok: true });
}
