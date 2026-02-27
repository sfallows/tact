import { execSync } from "node:child_process";
import { Bot } from "grammy";
import { clearHandler } from "./bot/commands/clear.js";
import { helpHandler } from "./bot/commands/help.js";
import { startHandler } from "./bot/commands/start.js";
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
import { getConfig, getWorkingDirectory } from "./config.js";
import { getLogger, initLogger } from "./logger.js";
import {
  startNotificationPoller,
  stopNotificationPoller,
} from "./notification/queue.js";
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
        `You can also set a custom command in ccpa.config.json under "claude.command".`,
    );
    process.exit(1);
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

  // Create bot instance
  const bot = new Bot(config.telegram.botToken);

  // Apply middleware
  bot.use(authMiddleware);
  bot.use(rateLimitMiddleware);

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

  // Register bot commands with Telegram (shows autocomplete menu)
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Welcome message" },
      { command: "help", description: "Show help" },
      { command: "clear", description: "Clear conversation history" },
      { command: "compact", description: "Compress conversation context" },
    ]);
    logger.info("Telegram bot commands registered");
  } catch (err) {
    logger.warn(
      { error: err },
      "Failed to register bot commands with Telegram",
    );
  }

  // Start bot
  logger.info(
    { allowedUsers: config.access.allowedUserIds.length },
    "Starting Telegram Claude Bot",
  );

  await bot.start({
    onStart: (botInfo) => {
      logger.info({ username: botInfo.username }, "Bot is running");
    },
  });
}
