import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { getConfig, getWorkingDirectory } from "../config.js";
import { getLogger } from "../logger.js";

const HOME = homedir();
function sanitizePath(s: string): string {
  return s.replaceAll(HOME, "~");
}

export interface ExecuteOptions {
  prompt: string;
  userDir: string;
  downloadsPath?: string;
  sessionId?: string | null;
  onProgress?: (message: string) => void;
  onTextChunk?: (fullText: string) => void;
  effort?: string;
}

export interface ExecuteResult {
  success: boolean;
  output: string;
  sessionId?: string;
  error?: string;
  timedOut?: boolean;
}

// --- Busy lock ---
let _busy = false;

export function isClaudeBusy(): boolean {
  return _busy;
}

/**
 * Execute a Claude query using the CLI with streaming progress
 */
export async function executeClaudeQuery(
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  _busy = true;
  const { prompt, downloadsPath, sessionId, onProgress, onTextChunk, effort } =
    options;
  const logger = getLogger();
  const config = getConfig();

  // Inactivity timeout: kill process if no stdout/stderr data for this long (default 10 min)
  const inactivityTimeoutMs = (config.claudeTimeoutSeconds ?? 600) * 1000;

  // Append downloads path info to prompt if provided
  const fullPrompt = downloadsPath
    ? `${prompt}\n\n[System: To send files to the user, write them to: ${downloadsPath}]`
    : prompt;

  const args: string[] = [
    "-p",
    fullPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  // Resume previous session if we have a session ID
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  // Extended thinking mode
  if (effort) {
    args.push("--effort", effort);
  }

  const commandParts = config.claude.command.split(/\s+/);
  const claudeCommand = commandParts[0];
  const extraArgs = commandParts.slice(1);
  const cwd = getWorkingDirectory();
  logger.info(
    { command: claudeCommand, args: [...extraArgs, ...args], cwd },
    "Executing Claude CLI",
  );

  return new Promise<ExecuteResult>((rawResolve) => {
    const resolve = (result: ExecuteResult) => {
      _busy = false;
      rawResolve(result);
    };

    const allArgs = [...extraArgs, ...args];
    const proc = spawn(claudeCommand, allArgs, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrOutput = "";
    let lastResult: ExecuteResult | null = null;
    let currentSessionId: string | undefined;
    let lastAssistantText = ""; // Track last text response for fallback
    let killed = false;

    // --- Inactivity timeout ---
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

    const resetInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        logger.warn(
          { timeoutMs: inactivityTimeoutMs, sessionId: currentSessionId },
          "Claude process inactivity timeout — killing stalled process",
        );
        killed = true;
        proc.kill("SIGTERM");
        // Force kill after 10s if SIGTERM doesn't work
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }, 10000);
      }, inactivityTimeoutMs);
    };

    // Start the timer
    resetInactivityTimer();

    proc.stdout.on("data", (data: Buffer) => {
      // Reset inactivity timer on any stdout data
      resetInactivityTimer();

      const chunk = data.toString();

      // Parse streaming JSON lines
      const lines = chunk.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Extract session ID from init message
          if (
            event.type === "system" &&
            event.subtype === "init" &&
            event.session_id
          ) {
            currentSessionId = event.session_id;
          }

          // Extract text from assistant messages and send progress updates
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              // Capture text content for fallback and streaming
              if (block.type === "text" && block.text) {
                lastAssistantText = block.text;
                if (onTextChunk) {
                  onTextChunk(block.text);
                }
              }

              // Send progress updates for tool usage
              if (block.type === "tool_use") {
                const toolName = block.name || "unknown";
                let progressMsg = `Using ${toolName}...`;

                // Add more context for specific tools
                if (toolName === "Read" && block.input?.file_path) {
                  progressMsg = `Reading: ${sanitizePath(block.input.file_path)}`;
                } else if (toolName === "Grep" && block.input?.pattern) {
                  progressMsg = `Searching for: ${block.input.pattern}`;
                } else if (toolName === "Glob" && block.input?.pattern) {
                  progressMsg = `Finding files: ${sanitizePath(block.input.pattern)}`;
                } else if (toolName === "Bash" && block.input?.command) {
                  const sanitized = sanitizePath(block.input.command);
                  const cmd = sanitized.slice(0, 60);
                  progressMsg = `Running: ${cmd}${sanitized.length > 60 ? "..." : ""}`;
                } else if (toolName === "Edit" && block.input?.file_path) {
                  progressMsg = `Editing: ${sanitizePath(block.input.file_path)}`;
                } else if (toolName === "Write" && block.input?.file_path) {
                  progressMsg = `Writing: ${sanitizePath(block.input.file_path)}`;
                } else if (toolName === "WebSearch" && block.input?.query) {
                  progressMsg = `Searching web: ${block.input.query}`;
                } else if (toolName === "WebFetch" && block.input?.url) {
                  progressMsg = `Fetching: ${block.input.url}`;
                }

                logger.info(
                  { tool: toolName, input: block.input },
                  progressMsg,
                );
                if (onProgress) {
                  onProgress(progressMsg);
                }
              }
            }
          }

          // Log tool results
          if (event.type === "user" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "tool_result") {
                const result =
                  typeof block.content === "string"
                    ? block.content.slice(0, 500)
                    : JSON.stringify(block.content).slice(0, 500);
                logger.info(
                  { toolUseId: block.tool_use_id, isError: block.is_error },
                  `Tool result: ${result}${result.length >= 500 ? "..." : ""}`,
                );
              }
            }
          }

          // Capture the final result
          if (event.type === "result") {
            logger.debug({ event }, "Claude result event");
            // Error can be in event.result or event.errors array
            const errorMessage = event.is_error
              ? event.result ||
                (event.errors?.length ? event.errors.join("; ") : undefined)
              : undefined;
            lastResult = {
              success: !event.is_error,
              output: event.result || lastAssistantText || "",
              sessionId: event.session_id || currentSessionId,
              error: errorMessage,
            };
          }
        } catch {
          // Not valid JSON, ignore
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      // stderr activity also resets the timer
      resetInactivityTimer();

      const chunk = data.toString().trim();
      if (chunk) {
        stderrOutput += `${chunk}\n`;
        logger.debug({ stderr: chunk }, "Claude stderr");
      }
    });

    proc.on("close", (code) => {
      // Clear the inactivity timer
      if (inactivityTimer) clearTimeout(inactivityTimer);

      logger.debug({ code, killed }, "Claude process closed");

      if (killed) {
        resolve({
          success: false,
          output: lastAssistantText,
          sessionId: currentSessionId,
          error:
            "Session timed out (no activity). Send another message to retry.",
          timedOut: true,
        });
      } else if (lastResult) {
        if (!lastResult.success) {
          logger.error(
            {
              error: lastResult.error,
              output: lastResult.output?.slice(0, 1000),
              stderr: stderrOutput,
            },
            "Claude returned error",
          );
        }
        resolve(lastResult);
      } else if (code === 0) {
        // No result event but process succeeded - use last assistant text
        resolve({
          success: true,
          output: lastAssistantText || "No response received",
          sessionId: currentSessionId,
        });
      } else {
        const errorMsg =
          stderrOutput.trim() || `Claude exited with code ${code}`;
        logger.error(
          { code, stderr: stderrOutput, lastText: lastAssistantText },
          "Claude process failed",
        );
        resolve({
          success: false,
          output: lastAssistantText,
          error: errorMsg,
        });
      }
    });

    proc.on("error", (err) => {
      // Clear the inactivity timer
      if (inactivityTimer) clearTimeout(inactivityTimer);

      logger.error({ error: err.message }, "Claude process error");
      resolve({
        success: false,
        output: "",
        error: `Failed to start ${claudeCommand}: ${err.message}`,
      });
    });
  });
}
