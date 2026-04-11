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
    id: "read_file",
    name: "read_file",
    description:
      "Reads the contents of a file from disk and returns its text. " +
      "Use this tool when you need to inspect, analyze, or reference the content of an existing file. " +
      "The path is resolved relative to the workspace root. " +
      "You may optionally specify an offset (1-based line number to start from) and a limit (maximum number of lines to return) to read a specific section instead of the entire file. " +
      "Returns a JSON object with: success (boolean), path (resolved absolute path), content (the file text or the requested slice), and lines_read (number of lines returned). " +
      "If the file does not exist, is a directory, or cannot be read, returns success=false with an error field describing the problem.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root, or an absolute path within the workspace" },
        offset: { type: "number", description: "1-based line number to start reading from. Defaults to 1 (beginning of file)" },
        limit: { type: "number", description: "Maximum number of lines to return. If omitted, returns all lines from offset to end of file" },
      },
      required: ["path"],
    },
  },
  {
    id: "write_file",
    name: "write_file",
    description:
      "Creates a new file on disk with the provided content. " +
      "Use this tool ONLY to create files that do not yet exist. If the file already exists, this tool will fail — use edit_file instead to modify existing files. " +
      "The path is resolved relative to the workspace root. The parent directory must already exist. " +
      "Returns a JSON object with: success (boolean), path (resolved absolute path), and bytes_written (number of bytes written). " +
      "If the file already exists, the parent directory is missing, or the write fails, returns success=false with an error field describing the problem.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path for the new file, relative to the workspace root or absolute within the workspace" },
        content: { type: "string", description: "Full text content to write into the new file" },
      },
      required: ["path", "content"],
    },
  },
  {
    id: "edit_file",
    name: "edit_file",
    description:
      "Modifies an existing file by finding and replacing a specific text fragment. " +
      "Use this tool to make targeted changes to files that already exist on disk. " +
      "Provide the exact text to find (old_string) and the text to replace it with (new_string). Only the first occurrence of old_string is replaced. " +
      "The path is resolved relative to the workspace root. " +
      "Requires user confirmation before executing. " +
      "Returns a JSON object with: success (boolean), path (resolved absolute path), and replacements (number of replacements made, always 1 on success). " +
      "If the file does not exist, use write_file instead. If old_string is not found in the file, returns success=false with an error field explaining that no match was found and no changes were made.",
    risk: "medium",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the existing file to edit, relative to workspace root or absolute within the workspace" },
        old_string: { type: "string", description: "Exact text fragment to search for in the file. Must match exactly (case-sensitive, including whitespace)" },
        new_string: { type: "string", description: "Text that will replace the first occurrence of old_string" },
      },
      required: ["path", "old_string", "new_string"],
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
