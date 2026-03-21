import { appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getWorkingDirectory } from "../config.js";

// Patterns that may indicate secrets — redacted before writing to the log.
// Ordered from most specific to most general to avoid double-matching.
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Telegram bot token: <10 digits>:<35 base64url chars>
  { pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, replacement: "[BOT_TOKEN]" },
  // Anthropic API key
  {
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[ANTHROPIC_KEY]",
  },
  // Generic sk- key (OpenAI-style)
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: "[API_KEY]" },
  // AWS access key
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[AWS_KEY]" },
  // KEY=value / key: value for common secret field names
  {
    pattern:
      /((?:api[_-]?key|secret[_-]?key|auth[_-]?token|password|bot[_-]?token)\s*[=:]\s*)([^\s\n"'`]{8,})/gi,
    replacement: "$1[REDACTED]",
  },
  // Bearer <token> in auth headers
  {
    pattern: /\bBearer\s+([A-Za-z0-9._\-+/]{20,})\b/g,
    replacement: "Bearer [TOKEN]",
  },
];

function sanitize(text: string): string {
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function getLogPath(): string {
  const date = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Chicago",
  }); // YYYY-MM-DD in CT
  return join(getWorkingDirectory(), ".tact", `chat-log-${date}.md`);
}

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "America/Chicago",
  });
}

/** Write a date header once, on first write of the day. */
async function ensureHeader(path: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    // File doesn't exist yet — write the daily header
    const header = `# ${new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "America/Chicago",
    })}\n\n`;
    await appendFile(path, header, "utf-8");
  }
}

/**
 * Append a message to today's chat log. Secrets are redacted before writing.
 * Fire-and-forget — never throws.
 */
export function appendChatLog(sender: string, text: string): void {
  if (!text || !text.trim()) return;
  const sanitized = sanitize(text.trim());
  const entry = `[${timestamp()}] ${sender}:\n${sanitized}\n\n`;
  const path = getLogPath();
  (async () => {
    await ensureHeader(path);
    await appendFile(path, entry, "utf-8");
  })().catch(() => {});
}
