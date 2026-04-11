import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient } from "@agents/db";
import { resumeAgent } from "@agents/agent";
import { decrypt } from "@/lib/crypto";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { toolCallId, action } = await request.json();
    if (!toolCallId || !["approve", "reject"].includes(action)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const db = createServerClient();

    const { data: toolCall } = await db
      .from("tool_calls")
      .select("*, agent_sessions!inner(user_id)")
      .eq("id", toolCallId)
      .eq("status", "pending_confirmation")
      .single();

    if (!toolCall) {
      return NextResponse.json({ error: "Tool call not found or already resolved" }, { status: 404 });
    }

    const sessionUserId = (toolCall.agent_sessions as Record<string, unknown>).user_id;
    if (sessionUserId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const sessionId = toolCall.session_id as string;

    const { data: profile } = await supabase
      .from("profiles")
      .select("agent_system_prompt")
      .eq("id", user.id)
      .single();

    const { data: toolSettings } = await supabase
      .from("user_tool_settings")
      .select("*")
      .eq("user_id", user.id);

    const { data: integrations } = await supabase
      .from("user_integrations")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "active");

    let githubToken: string | undefined;
    const ghIntegration = (integrations ?? []).find(
      (i: Record<string, unknown>) => i.provider === "github"
    );
    if (ghIntegration?.encrypted_tokens) {
      try {
        githubToken = decrypt(ghIntegration.encrypted_tokens as string);
      } catch {
        // token decryption failed
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
        // token decryption/parsing failed
      }
    }

    const result = await resumeAgent({
      message: "",
      userId: user.id,
      sessionId,
      systemPrompt: (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
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
      resumeAction: action,
    });

    return NextResponse.json({
      status: action === "approve" ? "executed" : "rejected",
      result: { message: result.response },
    });
  } catch (error) {
    console.error("Confirm API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
