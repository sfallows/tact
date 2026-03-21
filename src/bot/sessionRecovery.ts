import { type ExecuteOptions, executeClaudeQuery } from "../claude/executor.js";
import { type ParsedResponse, parseClaudeOutput } from "../claude/parser.js";
import { getLogger } from "../logger.js";
import { saveSessionId } from "../user/setup.js";

/**
 * Execute a Claude query with automatic corrupted-session recovery.
 * On detection of a corrupted session error, clears the session and retries once.
 * Saves the new session ID on success.
 */
export async function executeWithRecovery(
  options: Omit<ExecuteOptions, "sessionId">,
  sessionId: string | null,
): Promise<ParsedResponse> {
  const logger = getLogger();
  const { userDir } = options;

  let result = await executeClaudeQuery({ ...options, sessionId });

  if (!result.success && sessionId && isCorruptedSessionError(result.error)) {
    logger.warn(
      { sessionId, error: result.error },
      "Corrupted session — clearing and retrying with fresh session",
    );
    await saveSessionId(userDir, null);
    result = await executeClaudeQuery({ ...options, sessionId: null });
  }

  const parsed = parseClaudeOutput(result);

  if (parsed.sessionId && !isCorruptedSessionError(result.error)) {
    await saveSessionId(userDir, parsed.sessionId);
  }

  return parsed;
}

/**
 * Detect if an error indicates a corrupted session (mismatched tool_use/tool_result blocks).
 * These happen when a session is killed mid-tool-use and the conversation history becomes invalid.
 */
export function isCorruptedSessionError(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("tool_use_id") ||
    lower.includes("tool_result") ||
    lower.includes("tool_use blocks") ||
    (lower.includes("400") && lower.includes("invalid_request_error")) ||
    lower.includes("conversation history is malformed") ||
    lower.includes("unexpected role")
  );
}

/**
 * Detect if an error indicates an expired OAuth token requiring re-authentication.
 */
export function isAuthExpiredError(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("oauth token has expired") ||
    lower.includes("authentication_error") ||
    (lower.includes("401") && lower.includes("token"))
  );
}

/**
 * Detect if an error indicates a session that no longer exists (expired or unknown).
 * Claude Code sessions are stored locally, but can become invalid after a long gap.
 */
export function isSessionNotFoundError(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("session not found") ||
    lower.includes("unknown session") ||
    lower.includes("invalid session") ||
    lower.includes("session has expired") ||
    lower.includes("no such session") ||
    lower.includes("session_id") ||
    (lower.includes("404") && lower.includes("session"))
  );
}
