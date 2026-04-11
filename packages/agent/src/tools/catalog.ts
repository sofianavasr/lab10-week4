import type { ToolDefinition, ToolRisk } from "@agents/types";

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: "get_user_preferences",
    name: "get_user_preferences",
    description: "Returns the current user preferences and agent configuration.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "list_enabled_tools",
    name: "list_enabled_tools",
    description: "Lists all tools the user has currently enabled.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "github_list_repos",
    name: "github_list_repos",
    description: "Lists the user's GitHub repositories.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Results per page (max 30)" },
      },
      required: [],
    },
  },
  {
    id: "github_list_issues",
    name: "github_list_issues",
    description: "Lists issues for a given repository.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["owner", "repo"],
    },
  },
  {
    id: "github_create_issue",
    name: "github_create_issue",
    description: "Creates a new issue in a GitHub repository. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    id: "github_create_repo",
    name: "github_create_repo",
    description: "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Repository description" },
        is_private: { type: "boolean", description: "Whether the repo is private" },
      },
      required: ["name"],
    },
  },
  {
    id: "notion_get_idea_tags",
    name: "notion_get_idea_tags",
    description:
      "Fetches available tags from the user's Notion ideas database so the user can pick one existing tag or ask to create a new one.",
    risk: "low",
    requires_integration: "notion",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "notion_create_idea",
    name: "notion_create_idea",
    description:
      "Creates a new idea page in the user's Notion ideas database. Ask for Name, let the user pick one Tag (or create a new tag), ask optional Inspired by URL, and always set Status to Idea.",
    risk: "low",
    requires_integration: "notion",
    parameters_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Idea title (required)" },
        tag: {
          type: "string",
          description: "Single tag to assign (existing or new)",
        },
        inspired_by: {
          type: "string",
          description: "Optional inspiration URL",
        },
      },
      required: ["name"],
    },
  },
  {
    id: "get_weather",
    name: "get_weather",
    description: "Gets the current weather for a given city using the Open-Meteo API.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name to get the weather for" },
      },
      required: ["city"],
    },
  },
  {
    id: "bash",
    name: "bash",
    description: "Executes a shell command on the server host. Requires confirmation.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        terminal: {
          type: "string",
          description: "Logical terminal identifier for correlation/logs",
        },
        prompt: {
          type: "string",
          description: "Shell command to execute via bash -lc",
        },
      },
      required: ["prompt"],
    },
  },
];

export function getToolRisk(toolId: string): ToolRisk {
  return TOOL_CATALOG.find((t) => t.id === toolId)?.risk ?? "high";
}

export function toolRequiresConfirmation(toolId: string): boolean {
  const risk = getToolRisk(toolId);
  return risk === "medium" || risk === "high";
}
