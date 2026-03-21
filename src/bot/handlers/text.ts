import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "grammy";
import { executeClaudeQuery } from "../../claude/executor.js";
import { getConfig, getWorkingDirectory } from "../../config.js";
import { TELEGRAM_MAX_LENGTH } from "../../constants.js";
import { getLogger } from "../../logger.js";
import { drainAllNotifications } from "../../notification/queue.js";
import { sendChunkedResponse } from "../../telegram/chunker.js";
import { sendDownloadFiles } from "../../telegram/fileSender.js";
import {
  ensureUserSetup,
  getDownloadsPath,
  getSessionId,
  saveSessionId,
} from "../../user/setup.js";
import { drainAll } from "../../webhook/queue.js";
import { bufferMessage } from "../messageBuffer.js";
import {
  isAuthExpiredError,
  isCorruptedSessionError,
  isSessionNotFoundError,
} from "../sessionRecovery.js";

// Heartbeat file path — written on message receive and reply (lazy init)
let _heartbeatPath: string | null = null;
function getHeartbeatPath(): string {
  if (!_heartbeatPath) {
    _heartbeatPath = join(getWorkingDirectory(), ".tact", "heartbeat.json");
  }
  return _heartbeatPath;
}

interface HeartbeatState {
  lastMessageReceived: number;
  lastReplySent: number | null;
  userId: number;
  status: "processing" | "idle";
}

async function writeHeartbeat(state: HeartbeatState): Promise<void> {
  try {
    await writeFile(
      getHeartbeatPath(),
      JSON.stringify(state, null, 2),
      "utf-8",
    );
  } catch (err) {
    const logger = getLogger();
    logger.warn(
      { error: err },
      "Failed to write heartbeat — session recovery may be unreliable",
    );
  }
}

/** Format a Unix timestamp (seconds) as "h:MM AM/PM CT" */
function formatTimestamp(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return `${date.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Chicago",
  })} CT`;
}

// How often to update the streaming message (ms)
const STREAM_UPDATE_INTERVAL = 1500;

/**
 * Process a message (or combined messages) through Claude
 */
export async function processMessage(
  ctx: Context,
  messageText: string,
): Promise<void> {
  const config = getConfig();
  const logger = getLogger();
  const userId = ctx.from?.id;

  if (!userId) return;

  const userDir = resolve(join(config.dataDir, String(userId)));

  // Declared outside try so catch can clear it on any error path
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

  try {
    // Acknowledge receipt immediately — expires after 5s but bridges gap before "Processing..." appears
    ctx.replyWithChatAction("typing").catch(() => {});

    logger.debug({ userDir }, "Setting up user directory");
    await ensureUserSetup(userDir);

    if (!messageText.trim()) {
      await ctx.reply("Please provide a message.");
      return;
    }

    // Write heartbeat: message received, processing
    await writeHeartbeat({
      lastMessageReceived: Date.now(),
      lastReplySent: null,
      userId,
      status: "processing",
    });

    // Inject message timestamp into context for Claude
    const msgDate = ctx.message?.date;
    const timestampPrefix = msgDate
      ? `[sent at ${formatTimestamp(msgDate)}] `
      : "";
    const promptText = `${timestampPrefix}${messageText}`;

    const sessionId = await getSessionId(userDir);
    logger.debug({ sessionId: sessionId || "new" }, "Session");

    // Send initial status message (will be edited with streaming text)
    const statusMsg = await ctx.reply("_Processing..._", {
      parse_mode: "Markdown",
    });
    const chatId = ctx.chat!.id;
    const statusMsgId = statusMsg.message_id;

    // --- Streaming state ---
    let streamedText = "";
    let lastStreamUpdate = 0;
    let streamUpdatePending = false;
    let isInToolUse = false; // True when Claude is using tools (show progress, not text)

    // Flush streamed text to Telegram message
    const flushStreamedText = async () => {
      if (!streamedText || isInToolUse) return;
      const now = Date.now();
      if (now - lastStreamUpdate < STREAM_UPDATE_INTERVAL) {
        // Schedule a deferred update if not already pending
        if (!streamUpdatePending) {
          streamUpdatePending = true;
          setTimeout(
            () => {
              streamUpdatePending = false;
              flushStreamedText().catch(() => {
                // Ignore — Telegram edit errors are non-fatal
              });
            },
            STREAM_UPDATE_INTERVAL - (now - lastStreamUpdate),
          );
        }
        return;
      }
      lastStreamUpdate = now;
      try {
        // Show last portion if text exceeds Telegram limit (keep room for cursor)
        const display =
          streamedText.length > TELEGRAM_MAX_LENGTH - 10
            ? `...${streamedText.slice(-(TELEGRAM_MAX_LENGTH - 10))}`
            : streamedText;
        await ctx.api.editMessageText(chatId, statusMsgId, `${display} ▍`);
      } catch {
        // Ignore edit errors (rate limit, message not modified, etc.)
      }
    };

    // Text streaming callback — accumulates text, triggers periodic edits
    const onTextChunk = (fullText: string) => {
      isInToolUse = false; // Text arrived, switch back from tool progress
      streamedText = fullText;
      flushStreamedText();
    };

    // Progress callback — shows tool usage (switches away from streaming text)
    let lastProgressUpdate = Date.now();
    let lastProgressText = "";
    const onProgress = async (message: string) => {
      isInToolUse = true;
      const now = Date.now();
      if (now - lastProgressUpdate > 2000) {
        lastProgressUpdate = now;
        lastProgressText = message;
        try {
          await ctx.api.editMessageText(chatId, statusMsgId, `_${message}_`, {
            parse_mode: "Markdown",
          });
        } catch {
          // Ignore edit errors
        }
      }
    };

    // Heartbeat: edit status message every 15s if no recent progress update
    const processStart = Date.now();
    heartbeatInterval = setInterval(async () => {
      if (Date.now() - lastProgressUpdate < 12000) return; // recent update, skip
      const elapsed = Math.round((Date.now() - processStart) / 1000);
      const label = lastProgressText ? `${lastProgressText} ` : "Working ";
      try {
        await ctx.api.editMessageText(
          chatId,
          statusMsgId,
          `_${label}(${elapsed}s)_`,
          { parse_mode: "Markdown" },
        );
      } catch {
        // Ignore
      }
    }, 15000);

    const downloadsPath = getDownloadsPath(userDir);

    logger.debug("Executing Claude query");
    let result = await executeClaudeQuery({
      prompt: promptText,
      userDir,
      downloadsPath,
      sessionId,
      onProgress,
      onTextChunk,
    });
    clearInterval(heartbeatInterval);
    logger.debug(
      {
        success: result.success,
        error: result.error,
        timedOut: result.timedOut,
      },
      "Claude result",
    );

    // Auto-recover from corrupted sessions: clear session and retry once
    if (!result.success && sessionId && isCorruptedSessionError(result.error)) {
      logger.warn(
        { sessionId, error: result.error },
        "Corrupted session detected — retrying with fresh session",
      );
      // Don't pre-clear: preserve session on disk in case this is a false positive.
      // If retry succeeds it will save a new session ID; if it also fails we clear below.

      // Update status message to inform user
      try {
        await ctx.api.editMessageText(
          chatId,
          statusMsgId,
          "_Session reset, retrying..._",
          { parse_mode: "Markdown" },
        );
      } catch {
        // Ignore edit errors
      }

      // Reset streaming state for retry
      streamedText = "";
      lastStreamUpdate = 0;
      streamUpdatePending = false;
      isInToolUse = false;
      lastProgressUpdate = Date.now();
      lastProgressText = "";

      // Restart heartbeat for retry (was cleared after first call)
      heartbeatInterval = setInterval(async () => {
        if (Date.now() - lastProgressUpdate < 12000) return;
        const elapsed = Math.round((Date.now() - processStart) / 1000);
        const label = lastProgressText ? `${lastProgressText} ` : "Working ";
        try {
          await ctx.api.editMessageText(
            chatId,
            statusMsgId,
            `_${label}(${elapsed}s)_`,
            { parse_mode: "Markdown" },
          );
        } catch {
          // Ignore
        }
      }, 15000);

      result = await executeClaudeQuery({
        prompt: promptText,
        userDir,
        downloadsPath,
        sessionId: null,
        onProgress,
        onTextChunk,
      });
      clearInterval(heartbeatInterval);
      logger.info(
        { success: result.success, newSessionId: result.sessionId },
        "Retry after session reset",
      );
      // If the retry also failed, clear the session to prevent a corruption loop
      if (!result.success) {
        await saveSessionId(userDir, null);
        logger.warn({ userDir }, "Cleared session after failed retry");
      }
    }
    // Timed out or session not found — clear session and retry once with a fresh session
    if (
      !result.success &&
      sessionId &&
      (result.timedOut || isSessionNotFoundError(result.error))
    ) {
      const reason = result.timedOut ? "timed out" : "session not found";
      logger.warn(
        { sessionId, reason, error: result.error },
        "Session unresumable — clearing and retrying fresh",
      );
      await saveSessionId(userDir, null);

      try {
        await ctx.api.editMessageText(
          chatId,
          statusMsgId,
          "_Session reset, retrying..._",
          { parse_mode: "Markdown" },
        );
      } catch {
        // Ignore edit errors
      }

      streamedText = "";
      lastStreamUpdate = 0;
      streamUpdatePending = false;
      isInToolUse = false;
      lastProgressUpdate = Date.now();
      lastProgressText = "";

      heartbeatInterval = setInterval(async () => {
        if (Date.now() - lastProgressUpdate < 12000) return;
        const elapsed = Math.round((Date.now() - processStart) / 1000);
        const label = lastProgressText ? `${lastProgressText} ` : "Working ";
        try {
          await ctx.api.editMessageText(
            chatId,
            statusMsgId,
            `_${label}(${elapsed}s)_`,
            { parse_mode: "Markdown" },
          );
        } catch {
          // Ignore
        }
      }, 15000);

      result = await executeClaudeQuery({
        prompt: promptText,
        userDir,
        downloadsPath,
        sessionId: null,
        onProgress,
        onTextChunk,
      });
      clearInterval(heartbeatInterval);
      logger.info(
        { success: result.success, newSessionId: result.sessionId },
        "Retry after session clear",
      );
    }

    // Auth expired — notify user to use /login
    if (!result.success && isAuthExpiredError(result.error)) {
      try {
        await ctx.api.deleteMessage(chatId, statusMsgId);
      } catch {
        /* ignore */
      }
      await ctx.reply(
        "Claude authentication has expired.\n\nUse /login to re-authenticate, then paste the code back with /login <code>",
      );
      return;
    }

    // Delete the streaming status message — we'll send the final response as a new message
    try {
      await ctx.api.deleteMessage(chatId, statusMsgId);
    } catch {
      // Ignore delete errors
    }

    // Only save session if the result was successful (don't persist corrupted sessions)
    if (
      result.sessionId &&
      result.success &&
      !isCorruptedSessionError(result.error)
    ) {
      await saveSessionId(userDir, result.sessionId);
      logger.debug({ sessionId: result.sessionId }, "Session saved");
    }

    const responseText = result.success
      ? result.output
      : result.error || "An error occurred";
    await sendChunkedResponse(ctx, responseText);
    logger.debug("Response sent");

    // Write heartbeat: reply sent, idle
    await writeHeartbeat({
      lastMessageReceived: Date.now(),
      lastReplySent: Date.now(),
      userId,
      status: "idle",
    });

    // Send any files from downloads folder
    const filesSent = await sendDownloadFiles(ctx, userDir);
    if (filesSent > 0) {
      logger.info({ filesSent }, "Sent download files to user");
    }

    // Drain any queued webhooks now that Claude is idle
    try {
      await drainAll();
    } catch (drainErr) {
      logger.error(
        { error: drainErr },
        "Error draining webhook queue after message",
      );
    }

    // Drain any queued notifications now that Claude is idle
    try {
      await drainAllNotifications();
    } catch (drainErr) {
      logger.error(
        { error: drainErr },
        "Error draining notification queue after message",
      );
    }
  } catch (error) {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    logger.error({ error }, "Text handler error");
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    await ctx.reply(`An error occurred: ${errorMessage}`);

    // Write heartbeat: error state, idle
    await writeHeartbeat({
      lastMessageReceived: Date.now(),
      lastReplySent: Date.now(),
      userId,
      status: "idle",
    });
  }
}

/**
 * Handle text messages - buffers then routes to Claude
 */
export async function textHandler(ctx: Context): Promise<void> {
  const logger = getLogger();
  const userId = ctx.from?.id;
  const messageText = ctx.message?.text;

  if (!userId || !messageText) {
    return;
  }

  logger.debug(
    {
      userId,
      username: ctx.from?.username,
      name: ctx.from?.first_name,
    },
    "Message received",
  );

  const trimmed = messageText.trim();
  if (trimmed === "/login" || trimmed.startsWith("/login ")) {
    const config = getConfig();
    const n8nUrl =
      config.loginWebhookUrl ||
      process.env.LOGIN_WEBHOOK_URL ||
      "http://100.106.8.87:5678/webhook/claude-login";
    const parts = trimmed.split(/\s+/);
    const code = parts.length > 1 ? parts.slice(1).join("").trim() : "";
    try {
      if (code) {
        // Submit the code to the waiting auth helper
        const resp = await fetch(n8nUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "submit_code", code }),
        });
        if (!resp.ok) {
          await ctx.reply(
            `Code submission failed (HTTP ${resp.status}). Check n8n.`,
          );
          return;
        }
        await ctx.reply("Code submitted — checking authentication...");
        // Poll n8n for result (up to 30s total)
        let authResult = "";
        const pollDeadline = Date.now() + 33000;
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          if (Date.now() > pollDeadline) break;
          try {
            const ac = new AbortController();
            const fetchTimeout = setTimeout(() => ac.abort(), 5000);
            const checkResp = await fetch(n8nUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "check" }),
              signal: ac.signal,
            }).finally(() => clearTimeout(fetchTimeout));
            if (checkResp.ok) {
              const data = (await checkResp.json()) as { text?: string };
              const status = data.text || "";
              if (status.includes("success") || status.includes("successful")) {
                authResult =
                  "Authentication successful! Claude is now logged in.";
                break;
              } else if (
                status.includes("error") ||
                status.includes("failed")
              ) {
                authResult = `Authentication failed: ${status}\n\nSend /login to try again.`;
                break;
              }
            }
          } catch {
            // ignore poll errors, keep trying
          }
        }
        if (authResult) {
          await ctx.reply(authResult);
        } else {
          await ctx.reply(
            "Authentication timed out — check /tmp/claude-auth/log on server, or SSH in and run: claude auth status",
          );
        }
      } else {
        // Start a new auth flow
        const resp = await fetch(n8nUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start" }),
        });
        if (!resp.ok) {
          await ctx.reply(
            `Login request failed (HTTP ${resp.status}). Check n8n.`,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Could not reach n8n: ${msg}`);
    }
    return;
  }

  await bufferMessage(ctx, messageText);
}
