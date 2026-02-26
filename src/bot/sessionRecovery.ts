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
