import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient } from "@agents/db";
import { decrypt } from "@/lib/crypto";
import { githubCreateIssue, githubCreateRepo } from "@/lib/github";

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

    if (action === "reject") {
      await db
        .from("tool_calls")
        .update({ status: "rejected", finished_at: new Date().toISOString() })
        .eq("id", toolCallId);
      return NextResponse.json({ status: "rejected", message: "Acción cancelada." });
    }

    const { data: integration } = await db
      .from("user_integrations")
      .select("encrypted_tokens")
      .eq("user_id", user.id)
      .eq("provider", "github")
      .eq("status", "active")
      .single();

    if (!integration?.encrypted_tokens) {
      return NextResponse.json({ error: "GitHub not connected" }, { status: 400 });
    }

    const token = decrypt(integration.encrypted_tokens);
    const args = toolCall.arguments_json as Record<string, unknown>;
    let result: Record<string, unknown>;

    switch (toolCall.tool_name) {
      case "github_create_issue": {
        const issue = await githubCreateIssue(
          token,
          args.owner as string,
          args.repo as string,
          args.title as string,
          (args.body as string) ?? ""
        );
        result = {
          message: `Issue creado: ${issue.title}`,
          issue_url: issue.html_url,
          issue_number: issue.number,
        };
        break;
      }
      case "github_create_repo": {
        const repo = await githubCreateRepo(
          token,
          args.name as string,
          (args.description as string) ?? "",
          (args.is_private as boolean) ?? false
        );
        result = {
          message: `Repositorio creado: ${repo.full_name}`,
          repo_url: repo.html_url,
        };
        break;
      }
      default:
        result = { error: `Unknown tool: ${toolCall.tool_name}` };
    }

    await db
      .from("tool_calls")
      .update({
        status: "executed",
        result_json: result,
        finished_at: new Date().toISOString(),
      })
      .eq("id", toolCallId);

    return NextResponse.json({ status: "executed", result });
  } catch (error) {
    console.error("Confirm API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
