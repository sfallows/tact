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
