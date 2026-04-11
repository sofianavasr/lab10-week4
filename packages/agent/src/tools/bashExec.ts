import { execFile, type ExecFileException } from "node:child_process";
import { statSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

export interface BashExecResult {
  terminal: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  error?: string;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getWorkingDirectory(): { cwd: string; error?: string } {
  const cwd = process.env.BASH_TOOL_CWD || process.cwd();
  try {
    const stats = statSync(cwd);
    if (!stats.isDirectory()) {
      return { cwd, error: `BASH_TOOL_CWD is not a directory: ${cwd}` };
    }
    return { cwd };
  } catch {
    return { cwd, error: `BASH_TOOL_CWD does not exist: ${cwd}` };
  }
}

function getExitCode(error: ExecFileException | null): number {
  if (!error) return 0;
  if (typeof error.code === "number") return error.code;
  return 1;
}

export async function executeBashCommand(
  prompt: string,
  terminal = "default"
): Promise<BashExecResult> {
  if (process.env.BASH_TOOL_ENABLED !== "true") {
    return {
      terminal,
      stdout: "",
      stderr: "",
      exitCode: 1,
      cwd: process.env.BASH_TOOL_CWD || process.cwd(),
      error: "Bash tool is disabled. Set BASH_TOOL_ENABLED=true.",
    };
  }

  const { cwd, error: cwdError } = getWorkingDirectory();
  if (cwdError) {
    return {
      terminal,
      stdout: "",
      stderr: "",
      exitCode: 1,
      cwd,
      error: cwdError,
    };
  }

  const timeout = parsePositiveInt(process.env.BASH_TOOL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxBuffer = parsePositiveInt(
    process.env.BASH_TOOL_MAX_BUFFER_BYTES,
    DEFAULT_MAX_BUFFER_BYTES
  );

  return await new Promise<BashExecResult>((resolve) => {
    execFile(
      "bash",
      ["-lc", prompt],
      { cwd, timeout, maxBuffer },
      (error, stdout, stderr) => {
        const exitCode = getExitCode(error);
        resolve({
          terminal,
          stdout,
          stderr,
          exitCode,
          cwd,
          ...(error ? { error: error.message } : {}),
        });
      }
    );
  });
}
