import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";
import { CronExpressionParser } from "cron-parser";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG, toolRequiresConfirmation } from "./catalog";
import { createToolCall, updateToolCallStatus, createCronjob } from "@agents/db";
import { executeBashCommand } from "./bashExec";
import { readFileOp, writeFileOp, editFileOp } from "./fileOps";

interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  notionToken?: string;
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
const NOTION_API = "https://api.notion.com";
const NOTION_VERSION = "2026-03-11";

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
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
          if (!ctx.githubToken) {
            return JSON.stringify({ error: "GitHub token not available" });
          }
          const needsConfirm = toolRequiresConfirmation("github_create_issue");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_create_issue", input, needsConfirm
          );
          if (needsConfirm) {
            const decision = interrupt({
              tool_call_id: record.id,
              tool_name: "github_create_issue",
              arguments: input,
              message: `Necesito tu confirmación para crear el issue "${input.title}" en ${input.owner}/${input.repo}.`,
            });
            if (decision === "reject") {
              await updateToolCallStatus(ctx.db, record.id, "rejected");
              return JSON.stringify({ rejected: true, message: "Acción cancelada por el usuario." });
            }
          }
          const res = await fetch(
            `${GH_API}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues`,
            {
              method: "POST",
              headers: { ...ghHeaders(ctx.githubToken), "Content-Type": "application/json" },
              body: JSON.stringify({ title: input.title, body: input.body }),
            }
          );
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            const err = { error: `GitHub API ${res.status}: ${body}` };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
          const issue = await res.json();
          const result = {
            message: `Issue creado: ${issue.title}`,
            issue_url: issue.html_url,
            issue_number: issue.number,
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
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
          if (!ctx.githubToken) {
            return JSON.stringify({ error: "GitHub token not available" });
          }
          const needsConfirm = toolRequiresConfirmation("github_create_repo");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_create_repo", input, needsConfirm
          );
          if (needsConfirm) {
            const decision = interrupt({
              tool_call_id: record.id,
              tool_name: "github_create_repo",
              arguments: input,
              message: `Necesito tu confirmación para crear el repositorio "${input.name}"${input.is_private ? " (privado)" : " (público)"}.`,
            });
            if (decision === "reject") {
              await updateToolCallStatus(ctx.db, record.id, "rejected");
              return JSON.stringify({ rejected: true, message: "Acción cancelada por el usuario." });
            }
          }
          const res = await fetch(`${GH_API}/user/repos`, {
            method: "POST",
            headers: { ...ghHeaders(ctx.githubToken), "Content-Type": "application/json" },
            body: JSON.stringify({
              name: input.name,
              description: input.description,
              private: input.is_private,
              auto_init: true,
            }),
          });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            const err = { error: `GitHub API ${res.status}: ${body}` };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
          const repo = await res.json();
          const result = {
            message: `Repositorio creado: ${repo.full_name}`,
            repo_url: repo.html_url,
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
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

  if (isToolAvailable("notion_get_idea_tags", ctx)) {
    tools.push(
      tool(
        async () => {
          if (!ctx.notionToken) {
            console.log("[notion_get_idea_tags] no notion token in context");
            return JSON.stringify({ error: "Notion token not available" });
          }
          const databaseId = process.env.NOTION_DATABASE_ID;
          if (!databaseId) {
            console.log("[notion_get_idea_tags] NOTION_DATABASE_ID not set");
            return JSON.stringify({ error: "NOTION_DATABASE_ID is not configured" });
          }

          console.log("[notion_get_idea_tags] fetching data source:", databaseId, "with Notion-Version:", NOTION_VERSION);

          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "notion_get_idea_tags",
            {},
            false
          );

          const res = await fetch(
            `${NOTION_API}/v1/data_sources/${encodeURIComponent(databaseId)}`,
            { headers: notionHeaders(ctx.notionToken) }
          );
          console.log("[notion_get_idea_tags] Notion API response status:", res.status);
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.log("[notion_get_idea_tags] Notion API error body:", body);
            const err = { error: `Notion API ${res.status}: ${body}` };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }

          const database = (await res.json()) as {
            properties?: Record<
              string,
              {
                type?: string;
                select?: { options?: Array<{ name?: string; color?: string }> };
                multi_select?: { options?: Array<{ name?: string; color?: string }> };
              }
            >;
          };
          const properties = database.properties ?? {};
          const tagProperty =
            properties.Tags ??
            Object.values(properties).find(
              (p) => p?.type === "select" || p?.type === "multi_select"
            );
          const options =
            tagProperty?.select?.options ?? tagProperty?.multi_select?.options ?? [];

          const result = {
            tags: options
              .filter((o) => typeof o?.name === "string")
              .map((o) => ({
                name: o.name as string,
                color: o.color ?? "default",
              })),
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
        },
        {
          name: "notion_get_idea_tags",
          description:
            "Fetches available tags from the Notion ideas database so the user can pick existing tags or ask to create one.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("notion_create_idea", ctx)) {
    tools.push(
      tool(
        async (input) => {
          if (!ctx.notionToken) {
            console.log("[notion_create_idea] no notion token in context");
            return JSON.stringify({ error: "Notion token not available" });
          }
          const databaseId = process.env.NOTION_DATABASE_ID;
          if (!databaseId) {
            console.log("[notion_create_idea] NOTION_DATABASE_ID not set");
            return JSON.stringify({ error: "NOTION_DATABASE_ID is not configured" });
          }

          console.log("[notion_create_idea] creating page in database:", databaseId, "input:", JSON.stringify(input));

          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "notion_create_idea",
            input,
            false
          );

          const properties: Record<string, unknown> = {
            Name: {
              title: [{ text: { content: input.name } }],
            },
            Status: {
              status: { name: "Idea" },
            },
          };

          if (input.tag) {
            properties.Tags = {
              select: { name: input.tag },
            };
          }
          if (input.inspired_by) {
            properties["Inspired by"] = { url: input.inspired_by };
          }

          const res = await fetch(`${NOTION_API}/v1/pages`, {
            method: "POST",
            headers: notionHeaders(ctx.notionToken),
            body: JSON.stringify({
              parent: { data_source_id: databaseId },
              icon: { type: "emoji", emoji: "🧿" },
              properties,
            }),
          });
          console.log("[notion_create_idea] Notion API response status:", res.status);
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.log("[notion_create_idea] Notion API error body:", body);
            const err = { error: `Notion API ${res.status}: ${body}` };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }

          const page = (await res.json()) as { id?: string; url?: string };
          const result = {
            id: page.id ?? null,
            url: page.url ?? null,
            status: "Idea",
            icon: "🧿",
            name: input.name,
            tag: input.tag ?? null,
            inspired_by: input.inspired_by ?? null,
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
        },
        {
          name: "notion_create_idea",
          description:
            "Creates a new idea in the Notion database. Always sets Status to Idea and uses the 🧿 icon.",
          schema: z.object({
            name: z.string().min(1),
            tag: z.string().min(1).optional(),
            inspired_by: z.string().optional(),
          }),
        }
      )
    );
  }

  if (isToolAvailable("get_weather", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "get_weather", input, false
          );

          const geoRes = await fetch(
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(input.city)}&count=1&language=en`
          );
          if (!geoRes.ok) {
            const body = await geoRes.text().catch(() => "");
            const err = { error: `Geocoding API ${geoRes.status}: ${body}` };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
          const geoData = await geoRes.json();
          if (!geoData.results?.length) {
            const err = { error: `No location found for "${input.city}"` };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }

          const { latitude, longitude, name, country } = geoData.results[0];

          const weatherRes = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code`
          );
          if (!weatherRes.ok) {
            const body = await weatherRes.text().catch(() => "");
            const err = { error: `Weather API ${weatherRes.status}: ${body}` };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
          const weatherData = await weatherRes.json();

          const result = {
            location: { name, country, latitude, longitude },
            current: weatherData.current,
            current_units: weatherData.current_units,
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
        },
        {
          name: "get_weather",
          description: "Gets the current weather for a given city using the Open-Meteo API.",
          schema: z.object({
            city: z.string(),
          }),
        }
      )
    );
  }

  if (isToolAvailable("read_file", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(ctx.db, ctx.sessionId, "read_file", input, false);
          const result = await readFileOp(input.path, input.offset, input.limit);
          const status = result.success ? "executed" : "failed";
          await updateToolCallStatus(ctx.db, record.id, status, { ...result });
          return JSON.stringify(result);
        },
        {
          name: "read_file",
          description:
            "Reads the contents of a file from disk and returns its text. " +
            "Use this tool when you need to inspect, analyze, or reference the content of an existing file. " +
            "The path is resolved relative to the workspace root. " +
            "You may optionally specify an offset (1-based line number to start from) and a limit (maximum number of lines to return) to read a specific section instead of the entire file. " +
            "Returns a JSON object with: success (boolean), path (resolved absolute path), content (the file text or the requested slice), and lines_read (number of lines returned). " +
            "If the file does not exist, is a directory, or cannot be read, returns success=false with an error field describing the problem.",
          schema: z.object({
            path: z.string().min(1),
            offset: z.number().int().min(1).optional(),
            limit: z.number().int().min(1).optional(),
          }),
        }
      )
    );
  }

  if (isToolAvailable("write_file", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(ctx.db, ctx.sessionId, "write_file", input, false);
          const result = await writeFileOp(input.path, input.content);
          const status = result.success ? "executed" : "failed";
          await updateToolCallStatus(ctx.db, record.id, status, { ...result });
          return JSON.stringify(result);
        },
        {
          name: "write_file",
          description:
            "Creates a new file on disk with the provided content. " +
            "Use this tool ONLY to create files that do not yet exist. If the file already exists, this tool will fail — use edit_file instead to modify existing files. " +
            "The path is resolved relative to the workspace root. The parent directory must already exist. " +
            "Returns a JSON object with: success (boolean), path (resolved absolute path), and bytes_written (number of bytes written). " +
            "If the file already exists, the parent directory is missing, or the write fails, returns success=false with an error field describing the problem.",
          schema: z.object({
            path: z.string().min(1),
            content: z.string(),
          }),
        }
      )
    );
  }

  if (isToolAvailable("edit_file", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("edit_file");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "edit_file", input, needsConfirm
          );
          if (needsConfirm) {
            const preview =
              input.old_string.length > 80
                ? `${input.old_string.slice(0, 80)}...`
                : input.old_string;
            const decision = interrupt({
              tool_call_id: record.id,
              tool_name: "edit_file",
              arguments: input,
              message: `Se va a editar el archivo "${input.path}". ¿Aprobar?`,
            });
            if (decision === "reject") {
              await updateToolCallStatus(ctx.db, record.id, "rejected");
              return JSON.stringify({ rejected: true, message: "Acción cancelada por el usuario." });
            }
          }
          const result = await editFileOp(input.path, input.old_string, input.new_string);
          const status = result.success ? "executed" : "failed";
          await updateToolCallStatus(ctx.db, record.id, status, { ...result });
          return JSON.stringify(result);
        },
        {
          name: "edit_file",
          description:
            "Modifies an existing file by finding and replacing a specific text fragment. " +
            "Use this tool to make targeted changes to files that already exist on disk. " +
            "Provide the exact text to find (old_string) and the text to replace it with (new_string). Only the first occurrence of old_string is replaced. " +
            "The path is resolved relative to the workspace root. " +
            "Requires user confirmation before executing. " +
            "Returns a JSON object with: success (boolean), path (resolved absolute path), and replacements (number of replacements made, always 1 on success). " +
            "If the file does not exist, use write_file instead. If old_string is not found in the file, returns success=false with an error field explaining that no match was found and no changes were made.",
          schema: z.object({
            path: z.string().min(1),
            old_string: z.string().min(1),
            new_string: z.string(),
          }),
        }
      )
    );
  }

  if (isToolAvailable("create_cronjob", ctx)) {
    tools.push(
      tool(
        async (input) => {
          // Validate that the expression will fire in the future.
          // For run_once jobs we're stricter: if the next occurrence is not
          // today it means the requested time has already passed today.
          try {
            const now = new Date();
            const interval = CronExpressionParser.parse(input.expression, { currentDate: now });
            const nextFire = interval.next().toDate();

            if (input.run_once) {
              const todayStart = new Date(now);
              todayStart.setHours(0, 0, 0, 0);
              const todayEnd = new Date(now);
              todayEnd.setHours(23, 59, 59, 999);

              if (nextFire < todayStart || nextFire > todayEnd) {
                const nextStr = nextFire.toLocaleString("es-ES", {
                  dateStyle: "short",
                  timeStyle: "short",
                });
                return JSON.stringify({
                  error: true,
                  message:
                    `La hora especificada ya pasó. La próxima ejecución sería el ${nextStr}. ` +
                    `Por favor, elige una hora futura dentro del día de hoy o usa una expresión recurrente.`,
                });
              }
            }
          } catch {
            return JSON.stringify({
              error: true,
              message: `La expresión cron "${input.expression}" no es válida. Por favor, usa una expresión correcta.`,
            });
          }

          const needsConfirm = toolRequiresConfirmation("create_cronjob");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "create_cronjob", input, needsConfirm
          );
          if (needsConfirm) {
            const decision = interrupt({
              tool_call_id: record.id,
              tool_name: "create_cronjob",
              arguments: input,
              message: `Quieres programar la tarea "${input.jobname}" con la expresión \`${input.expression}\`${input.run_once ? " (se ejecutará una sola vez)" : ""}?`,
            });
            if (decision === "reject") {
              await updateToolCallStatus(ctx.db, record.id, "rejected");
              return JSON.stringify({ rejected: true, message: "Tarea programada cancelada." });
            }
          }
          const cronjob = await createCronjob(
            ctx.db, ctx.userId, input.jobname, input.description, input.expression, input.run_once ?? false
          );
          const result = {
            message: `Tarea programada "${cronjob.jobname}" creada correctamente (expresión: ${cronjob.expression}).`,
            id: cronjob.id,
            jobname: cronjob.jobname,
            expression: cronjob.expression,
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
        },
        {
          name: "create_cronjob",
          description:
            "Creates a scheduled task that will run automatically on the given cron schedule. " +
            "When fired, the agent will execute the provided description as a prompt and notify the user via Telegram. " +
            "Requires confirmation before saving.",
          schema: z.object({
            jobname: z.string().min(1).describe("Short human-readable name for the job"),
            description: z.string().min(1).describe("Prompt the agent will run each time the job fires"),
            expression: z.string().min(1).describe("Cron expression (e.g. '0 9 * * 1' for Mondays at 9am UTC)"),
            run_once: z.boolean().optional().describe("If true, deactivate the job after its first execution. Use for one-off tasks."),
          }),
        }
      )
    );
  }

  if (isToolAvailable("bash", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("bash");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "bash", input, needsConfirm
          );
          if (needsConfirm) {
            const promptPreview =
              input.prompt.length > 200 ? `${input.prompt.slice(0, 200)}...` : input.prompt;
            const decision = interrupt({
              tool_call_id: record.id,
              tool_name: "bash",
              arguments: input,
              message: `Se va a ejecutar en terminal "${input.terminal}": \`${promptPreview}\`. ¿Aprobar?`,
            });
            if (decision === "reject") {
              await updateToolCallStatus(ctx.db, record.id, "rejected");
              return JSON.stringify({ rejected: true, message: "Acción cancelada por el usuario." });
            }
          }

          const result = await executeBashCommand(input.prompt, input.terminal);
          const status = result.error ? "failed" : "executed";
          await updateToolCallStatus(ctx.db, record.id, status, { ...result });
          return JSON.stringify(result);
        },
        {
          name: "bash",
          description: "Executes a shell command on the server host. Requires confirmation.",
          schema: z.object({
            terminal: z.string().max(64).optional().default("default"),
            prompt: z.string().min(1).max(8192),
          }),
        }
      )
    );
  }

  return tools;
}
