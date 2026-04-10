import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG, toolRequiresConfirmation } from "./catalog";
import { createToolCall, updateToolCallStatus } from "@agents/db";

interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
}

function isToolAvailable(
  toolId: string,
  ctx: ToolContext
): boolean {
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;

  const def = TOOL_CATALOG.find((t) => t.id === toolId);
  if (def?.requires_integration) {
    const hasIntegration = ctx.integrations.some(
      (i) => i.provider === def.requires_integration && i.status === "active"
    );
    if (!hasIntegration) return false;
  }
  return true;
}

const GH_API = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function buildLangChainTools(ctx: ToolContext) {
  const tools = [];

  if (isToolAvailable("get_user_preferences", ctx)) {
    tools.push(
      tool(
        async () => {
          const { getProfile } = await import("@agents/db");
          const profile = await getProfile(ctx.db, ctx.userId);
          return JSON.stringify({
            name: profile.name,
            timezone: profile.timezone,
            language: profile.language,
            agent_name: profile.agent_name,
          });
        },
        {
          name: "get_user_preferences",
          description: "Returns the current user preferences and agent configuration.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("list_enabled_tools", ctx)) {
    tools.push(
      tool(
        async () => {
          const enabled = ctx.enabledTools
            .filter((t) => t.enabled)
            .map((t) => t.tool_id);
          return JSON.stringify(enabled);
        },
        {
          name: "list_enabled_tools",
          description: "Lists all tools the user has currently enabled.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("github_list_repos", ctx)) {
    tools.push(
      tool(
        async (input) => {
          if (!ctx.githubToken) {
            return JSON.stringify({ error: "GitHub token not available" });
          }
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_list_repos", input, false
          );
          const res = await fetch(
            `${GH_API}/user/repos?sort=updated&per_page=${input.per_page}`,
            { headers: ghHeaders(ctx.githubToken) }
          );
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            const err = { error: `GitHub API ${res.status}: ${body}` };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
          const repos = await res.json();
          const result = {
            repos: repos.map((r: Record<string, unknown>) => ({
              full_name: r.full_name,
              html_url: r.html_url,
              description: r.description,
              private: r.private,
              language: r.language,
              updated_at: r.updated_at,
            })),
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
        },
        {
          name: "github_list_repos",
          description: "Lists the user's GitHub repositories.",
          schema: z.object({
            per_page: z.number().max(30).optional().default(10),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_list_issues", ctx)) {
    tools.push(
      tool(
        async (input) => {
          if (!ctx.githubToken) {
            return JSON.stringify({ error: "GitHub token not available" });
          }
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_list_issues", input, false
          );
          const res = await fetch(
            `${GH_API}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues?state=${input.state}`,
            { headers: ghHeaders(ctx.githubToken) }
          );
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            const err = { error: `GitHub API ${res.status}: ${body}` };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
          const issues = await res.json();
          const result = {
            issues: issues.map((i: Record<string, unknown>) => ({
              number: i.number,
              title: i.title,
              html_url: i.html_url,
              state: i.state,
              created_at: i.created_at,
              user: (i.user as Record<string, unknown> | null)?.login ?? null,
            })),
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
        },
        {
          name: "github_list_issues",
          description: "Lists issues for a given repository.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            state: z.enum(["open", "closed", "all"]).optional().default("open"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_issue", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("github_create_issue");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_create_issue", input, needsConfirm
          );
          if (needsConfirm) {
            return JSON.stringify({
              pending_confirmation: true,
              tool_call_id: record.id,
              tool_name: "github_create_issue",
              arguments: input,
              message: `Necesito tu confirmación para crear el issue "${input.title}" en ${input.owner}/${input.repo}.`,
            });
          }
          return JSON.stringify({ error: "Unexpected: confirmation should be required" });
        },
        {
          name: "github_create_issue",
          description: "Creates a new issue in a GitHub repository. Requires confirmation.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            title: z.string(),
            body: z.string().optional().default(""),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_repo", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("github_create_repo");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_create_repo", input, needsConfirm
          );
          if (needsConfirm) {
            return JSON.stringify({
              pending_confirmation: true,
              tool_call_id: record.id,
              tool_name: "github_create_repo",
              arguments: input,
              message: `Necesito tu confirmación para crear el repositorio "${input.name}"${input.is_private ? " (privado)" : " (público)"}.`,
            });
          }
          return JSON.stringify({ error: "Unexpected: confirmation should be required" });
        },
        {
          name: "github_create_repo",
          description: "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
          schema: z.object({
            name: z.string(),
            description: z.string().optional().default(""),
            is_private: z.boolean().optional().default(false),
          }),
        }
      )
    );
  }

  return tools;
}
