import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";

export interface FileOpResult {
  success: boolean;
  path: string;
  error?: string;
  content?: string;
  lines_read?: number;
  bytes_written?: number;
  replacements?: number;
}

function getWorkspaceRoot(): string {
  return process.env.BASH_TOOL_CWD || process.cwd();
}

function resolveSafePath(inputPath: string): { absolute: string; error?: string } {
  const root = getWorkspaceRoot();
  const absolute = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(root, inputPath);

  if (!absolute.startsWith(root + "/") && absolute !== root) {
    return {
      absolute,
      error: `Path is outside the allowed workspace directory: "${absolute}" is not under "${root}"`,
    };
  }
  return { absolute };
}

export async function readFileOp(
  inputPath: string,
  offset?: number,
  limit?: number
): Promise<FileOpResult> {
  const { absolute, error: pathError } = resolveSafePath(inputPath);
  if (pathError) {
    return { success: false, path: inputPath, error: pathError };
  }

  try {
    const stats = statSync(absolute);
    if (!stats.isFile()) {
      return {
        success: false,
        path: absolute,
        error: `Path is not a regular file: "${absolute}"`,
      };
    }
  } catch {
    return {
      success: false,
      path: absolute,
      error: `File not found: "${absolute}"`,
    };
  }

  try {
    const raw = readFileSync(absolute, "utf-8");
    const allLines = raw.split("\n");

    const startIndex = offset !== undefined ? Math.max(0, offset - 1) : 0;
    const lines =
      limit !== undefined ? allLines.slice(startIndex, startIndex + limit) : allLines.slice(startIndex);

    const content = lines.join("\n");
    return {
      success: true,
      path: absolute,
      content,
      lines_read: lines.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      path: absolute,
      error: `Failed to read file "${absolute}": ${message}`,
    };
  }
}

export async function writeFileOp(
  inputPath: string,
  content: string
): Promise<FileOpResult> {
  const { absolute, error: pathError } = resolveSafePath(inputPath);
  if (pathError) {
    return { success: false, path: inputPath, error: pathError };
  }

  if (existsSync(absolute)) {
    return {
      success: false,
      path: absolute,
      error: `File already exists: "${absolute}". Use edit_file to modify existing files.`,
    };
  }

  const parentDir = dirname(absolute);
  if (!existsSync(parentDir)) {
    return {
      success: false,
      path: absolute,
      error: `Parent directory does not exist: "${parentDir}"`,
    };
  }

  try {
    writeFileSync(absolute, content, "utf-8");
    const bytes_written = Buffer.byteLength(content, "utf-8");
    return { success: true, path: absolute, bytes_written };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      path: absolute,
      error: `Failed to write file "${absolute}": ${message}`,
    };
  }
}

export async function editFileOp(
  inputPath: string,
  oldString: string,
  newString: string
): Promise<FileOpResult> {
  const { absolute, error: pathError } = resolveSafePath(inputPath);
  if (pathError) {
    return { success: false, path: inputPath, error: pathError };
  }

  try {
    statSync(absolute);
  } catch {
    return {
      success: false,
      path: absolute,
      error: `File not found: "${absolute}". Use write_file to create new files.`,
    };
  }

  let current: string;
  try {
    current = readFileSync(absolute, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      path: absolute,
      error: `Failed to read file "${absolute}": ${message}`,
    };
  }

  if (!current.includes(oldString)) {
    return {
      success: false,
      path: absolute,
      error: `old_string not found in file "${absolute}". No changes were made.`,
    };
  }

  const updated = current.replace(oldString, newString);

  try {
    writeFileSync(absolute, updated, "utf-8");
    return { success: true, path: absolute, replacements: 1 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      path: absolute,
      error: `Failed to write file "${absolute}": ${message}`,
    };
  }
}
