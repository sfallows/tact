import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "grammy";
import { executeClaudeQuery } from "../../claude/executor.js";
import { getConfig, getWorkingDirectory } from "../../config.js";
import { getLogger } from "../../logger.js";
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
import { isCorruptedSessionError } from "../sessionRecovery.js";

// Heartbeat file path — written on message receive and reply (lazy init)
let _heartbeatPath: string | null = null;
function getHeartbeatPath(): string {
  if (!_heartbeatPath) {
    _heartbeatPath = join(getWorkingDirectory(), ".ccpa", "heartbeat.json");
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
  } catch {
    // Non-fatal — don't let heartbeat failures break message handling
  }
}

/** Format a Unix timestamp (seconds) as "h:MM AM/PM CT" */
function formatTimestamp(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return (
    date.toLocaleString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Chicago",
    }) + " CT"
  );
}

// Telegram message length limit
const TG_MAX = 4096;
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

  try {
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
          streamedText.length > TG_MAX - 10
            ? "..." + streamedText.slice(-(TG_MAX - 10))
            : streamedText;
        await ctx.api.editMessageText(chatId, statusMsgId, display + " ▍");
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
      if (now - lastProgressUpdate > 2000 && message !== lastProgressText) {
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
        "Corrupted session detected — clearing and retrying",
      );
      await saveSessionId(userDir, null);

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

      result = await executeClaudeQuery({
        prompt: promptText,
        userDir,
        downloadsPath,
        sessionId: null,
        onProgress,
        onTextChunk,
      });
      logger.info(
        { success: result.success, newSessionId: result.sessionId },
        "Retry after session reset",
      );
    }

    // Delete the streaming status message — we'll send the final response as a new message
    try {
      await ctx.api.deleteMessage(chatId, statusMsgId);
    } catch {
      // Ignore delete errors
    }

    // Only save session if the result was successful (don't persist corrupted sessions)
    if (result.sessionId && !isCorruptedSessionError(result.error)) {
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
  } catch (error) {
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

  await bufferMessage(ctx, messageText);
}
