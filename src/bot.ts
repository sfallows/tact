import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Bot, type Context } from "grammy";
import { camHandler } from "./bot/commands/cam.js";
import { clearHandler } from "./bot/commands/clear.js";
import { fileHandler } from "./bot/commands/file.js";
import { helpHandler } from "./bot/commands/help.js";
import { noteHandler } from "./bot/commands/note.js";
import { remindHandler } from "./bot/commands/remind.js";
import { restartHandler } from "./bot/commands/restart.js";
import { searchHandler } from "./bot/commands/search.js";
import { searchLogHandler } from "./bot/commands/searchLog.js";
import { startHandler } from "./bot/commands/start.js";
import { statusHandler } from "./bot/commands/status.js";
import { tasksHandler } from "./bot/commands/tasks.js";
import { thinkHandler } from "./bot/commands/think.js";
import {
  documentHandler,
  photoHandler,
  textHandler,
  voiceHandler,
} from "./bot/handlers/index.js";
import { processMessage } from "./bot/handlers/text.js";
import { initMessageBuffer } from "./bot/messageBuffer.js";
import { authMiddleware } from "./bot/middleware/auth.js";
import { rateLimitMiddleware } from "./bot/middleware/rateLimit.js";
import { appendChatLog, rotateChatLogs } from "./chatlog/index.js";
import { getConfig, getWorkingDirectory } from "./config.js";
import { getLogger, initLogger } from "./logger.js";
import {
  startNotificationPoller,
  stopNotificationPoller,
} from "./notification/queue.js";
import {
  ackReminderByMsgId,
  startReminderPoller,
  stopReminderPoller,
} from "./reminder/index.js";
import { clearUserData } from "./user/setup.js";
import { startQueuePoller, stopQueuePoller } from "./webhook/queue.js";
import { startWebhookServer } from "./webhook/server.js";

/**
 * Check if the Claude CLI command is available
 */
function checkClaudeCommand(
  command: string,
  logger: ReturnType<typeof getLogger>,
): void {
  try {
    execSync(`${command} --version`, { stdio: "pipe" });
  } catch {
    logger.fatal(
      { command },
      `Claude CLI command "${command}" not found or not executable. ` +
        `Please ensure Claude Code is installed and the command is in your PATH. ` +
        `You can also set a custom command in tact.config.json under "claude.command".`,
    );
    process.exit(1);
  }
}

/**
 * Handle /login and /login <code> commands — routes to n8n, clears session on start.
 */
async function handleLogin(
  ctx: Context,
  config: ReturnType<typeof getConfig>,
): Promise<void> {
  const logger = getLogger();
  const userId = ctx.from?.id;
  const args = (
    typeof ctx.match === "string" ? ctx.match : (ctx.match?.[0] ?? "")
  ).trim();
  const n8nUrl = config.loginWebhookUrl;

  if (!n8nUrl) {
    await ctx.reply(
      "loginWebhookUrl is not configured. Set it in tact.config.json or LOGIN_WEBHOOK_URL env var.",
    );
    return;
  }

  // On /login start: clear the stale session so next message starts fresh
  if (!args && userId) {
    try {
      const { resolve, join } = await import("node:path");
      const userDir = resolve(join(config.dataDir, String(userId)));
      await clearUserData(userDir);
      logger.info({ userId }, "Session cleared for re-authentication");
    } catch (err) {
      logger.warn({ err }, "Could not clear session before login");
    }
  }

  try {
    const body = args
      ? JSON.stringify({ action: "submit_code", code: args })
      : JSON.stringify({ action: "start" });
    const resp = await fetch(n8nUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (resp.ok) {
      if (args) {
        await ctx.reply("Code submitted — checking authentication...");
      }
      // n8n will send the URL or result back via Telegram directly
    } else {
      await ctx.reply(`Login request failed (HTTP ${resp.status}). Check n8n.`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Could not reach n8n: ${msg}`);
  }
}

export async function startBot(): Promise<void> {
  const config = getConfig();
  const workingDir = getWorkingDirectory();

  // Initialize logger with config level
  initLogger(config.logging.level);
  const logger = getLogger();

  logger.info({ workingDir }, "Working directory");
  logger.info({ dataDir: config.dataDir }, "Data directory");

  // Rotate old chat logs on startup (delete logs > 90 days)
  rotateChatLogs(90);

  // Initialize message buffer
  initMessageBuffer(config.messageBufferMs, processMessage);
  if (config.messageBufferMs > 0) {
    logger.info(
      { delayMs: config.messageBufferMs },
      "Message buffering enabled",
    );
  }

  // Verify Claude CLI is available
  logger.debug({ command: config.claude.command }, "Checking Claude CLI");
  checkClaudeCommand(config.claude.command, logger);
  logger.info({ command: config.claude.command }, "Claude CLI verified");

  // Warn if transcription is configured but Whisper files are missing
  if (config.transcription) {
    const whisperBase = join(workingDir, ".claude", "whisper");
    const venv =
      config.transcription.venvPath ??
      join(whisperBase, "venv", "bin", "python");
    const script =
      config.transcription.scriptPath ?? join(whisperBase, "transcribe.py");
    if (!existsSync(venv) || !existsSync(script)) {
      logger.warn(
        { venv, script },
        "Transcription configured but Whisper venv/script not found — voice messages will fail until set up",
      );
    }
  }

  // Create bot instance
  const bot = new Bot(config.telegram.botToken);

  // Apply middleware (rate limit first to shed load before auth)
  bot.use(rateLimitMiddleware);
  bot.use(authMiddleware);

  // Register commands
  bot.command("start", startHandler);
  bot.command("help", helpHandler);
  bot.command("clear", clearHandler);

  // /compact — pass through to Claude as a regular message so it triggers compaction
  bot.command("compact", async (ctx) => {
    const text =
      "Please run /compact now to compress the conversation context.";
    await processMessage(ctx, text);
  });

  // /login — route to n8n for OAuth re-authentication (bypasses Claude)
  bot.command("login", async (ctx) => {
    await handleLogin(ctx, config);
  });

  // /restart — clear session and restart the bot service
  bot.command("restart", async (ctx) => {
    await restartHandler(ctx);
  });

  // /status — show runtime status
  bot.command("status", async (ctx) => {
    await statusHandler(ctx);
  });

  // /think — deep reasoning + peer review
  bot.command("think", async (ctx) => {
    await thinkHandler(ctx);
  });

  // /cam — capture the quint screen and send as a photo
  bot.command("cam", async (ctx) => {
    await camHandler(ctx);
  });

  // /remind — set a natural language reminder
  bot.command("remind", async (ctx) => {
    await remindHandler(ctx);
  });

  // /search — quick web search via Claude
  bot.command("search", async (ctx) => {
    await searchHandler(ctx);
  });

  // /note — append a quick note to today's Vault notes file
  bot.command("note", async (ctx) => {
    await noteHandler(ctx);
  });

  // /file — list downloads folder contents
  bot.command("file", async (ctx) => {
    await fileHandler(ctx);
  });

  // /tasks — show open items from tasks.md
  bot.command("tasks", async (ctx) => {
    await tasksHandler(ctx);
  });

  // /search-log — search chat log files
  bot.command("search-log", async (ctx) => {
    await searchLogHandler(ctx);
  });

  // Chat log — capture all inbound messages
  bot.on("message", (ctx, next) => {
    const msg = ctx.message;
    if (msg?.text) {
      appendChatLog("Sean", msg.text);
    } else if (msg?.photo) {
      appendChatLog("Sean", `[photo] ${msg.caption || "(no caption)"}`);
    } else if (msg?.document) {
      const name = msg.document.file_name || "document";
      appendChatLog("Sean", `[document: ${name}] ${msg.caption || ""}`);
    }
    // Voice is logged after transcription in the voice handler
    return next();
  });

  // Reaction handler — ✅ on a bot message acknowledges the related reminder
  bot.on("message_reaction", async (ctx) => {
    const reaction = ctx.messageReaction;
    const newReactions = reaction?.new_reaction ?? [];
    const hasCheckmark = newReactions.some(
      // biome-ignore lint/suspicious/noExplicitAny: Grammy emoji union type doesn't include ✅ yet
      (r) => r.type === "emoji" && (r.emoji as any) === "✅",
    );
    if (hasCheckmark && reaction?.message_id) {
      const acked = ackReminderByMsgId(reaction.message_id);
      if (acked) {
        getLogger().info(
          { messageId: reaction.message_id },
          "Reminder acknowledged via reaction",
        );
      }
    }
  });

  // Text message handler
  bot.on("message:text", textHandler);

  // Photo handler
  bot.on("message:photo", photoHandler);

  // Document handler (PDFs, etc.)
  bot.on("message:document", documentHandler);

  // Voice message handler
  bot.on("message:voice", voiceHandler);

  // Error handler
  bot.catch((err) => {
    logger.error({ error: err.error, ctx: err.ctx?.update }, "Bot error");
  });

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, "Received shutdown signal");
    stopQueuePoller();
    stopNotificationPoller();
    stopReminderPoller();
    await bot.stop();
    logger.info("Bot stopped");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Start webhook server for external triggers (n8n, GitHub, etc.)
  startWebhookServer(bot);

  // Start queue poller for processing queued webhooks
  await startQueuePoller(bot);

  // Start notification queue poller (SQLite-backed outbound messages)
  await startNotificationPoller(bot);

  // Start reminder poller (SQLite-backed, 30s check interval)
  await startReminderPoller(bot);

  // Register bot commands with Telegram (shows autocomplete menu)
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Welcome message" },
      { command: "help", description: "Show help" },
      { command: "clear", description: "Clear conversation history" },
      { command: "compact", description: "Compress conversation context" },
      {
        command: "login",
        description: "Re-authenticate Claude (OAuth expired)",
      },
      {
        command: "think",
        description: "Deep reasoning + peer review on a question",
      },
      {
        command: "cam",
        description: "Capture and send the current quint screen",
      },
      {
        command: "remind",
        description: "Set a reminder: /remind <message> in 2 hours",
      },
      {
        command: "search",
        description: "Quick web search: /search <query>",
      },
      {
        command: "note",
        description: "Append a quick note to today's Vault notes",
      },
      {
        command: "file",
        description: "List files in your downloads folder",
      },
      {
        command: "tasks",
        description: "Show open items from tasks.md",
      },
      {
        command: "search_log",
        description: "Search chat history: /search-log <term>",
      },
      {
        command: "restart",
        description: "Clear session and restart the bot",
      },
      {
        command: "status",
        description: "Show bot runtime status",
      },
    ]);
    logger.info("Telegram bot commands registered");
  } catch (err) {
    logger.warn(
      { error: err },
      "Failed to register bot commands with Telegram",
    );
  }

  // Startup recovery: detect unclean shutdowns via heartbeat.
  // We do NOT clear the session here — if Claude was mid-task, we keep the session
  // so the user can resume. If the session is corrupted, the text handler's
  // auto-recovery will detect it and retry fresh on the next message.
  try {
    const heartbeatPath = resolve(join(workingDir, ".tact", "heartbeat.json"));
    const raw = await readFile(heartbeatPath, "utf-8");
    const heartbeat = JSON.parse(raw) as { status?: string; userId?: number };
    if (heartbeat.status === "processing" && heartbeat.userId) {
      logger.warn(
        { userId: heartbeat.userId },
        "Unclean shutdown detected — keeping session (auto-recovery will handle corruption on next message)",
      );
    }
  } catch {
    // No heartbeat file or parse error — fresh boot, nothing to do
  }

  // Start bot
  logger.info(
    { allowedUsers: config.access.allowedUserIds.length },
    "Starting Telegram Claude Bot",
  );

  await bot.start({
    onStart: async (botInfo) => {
      logger.info({ username: botInfo.username }, "Bot is running");
      const userId = config.access.allowedUserIds[0];
      if (userId) {
        try {
          await bot.api.sendMessage(userId, "Bot is back online.");
        } catch (err) {
          logger.warn({ error: err }, "Failed to send startup notification");
        }
      }
    },
  });
}
