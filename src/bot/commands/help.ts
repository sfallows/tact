import type { Context } from "grammy";

export async function helpHandler(ctx: Context): Promise<void> {
  await ctx.reply(
    `*Claude Code Telegram Bot*\n\n` +
      `*Commands:*\n` +
      `/start - Welcome message\n` +
      `/help - Show this help\n` +
      `/clear - Clear conversation history\n` +
      `/compact - Compress conversation context\n` +
      `/status - Show bot and queue status\n` +
      `/restart - Restart the bot service\n` +
      `/think <question> - Extended thinking mode\n` +
      `/cam - Capture and send quint screen (macOS)\n` +
      `/remind <msg> <time> - Set a reminder\n` +
      `/search <query> - Quick web search via Claude\n` +
      `/note <text> - Append a quick note to today's Vault notes\n` +
      `/file - List files in your downloads folder\n` +
      `/tasks - Show open items from tasks.md\n` +
      `/search-log <term> - Search chat history\n` +
      `/login - Trigger Claude re-authentication\n` +
      `/login <code> - Submit auth code\n\n` +
      `*Usage:*\n` +
      `Just send any message to chat with Claude.\n` +
      `You can also send images, documents, and voice messages.\n\n` +
      `Your conversation history is preserved between messages. ` +
      `Use /clear to start a fresh conversation.\n\n` +
      `*Configuration:*\n` +
      `Claude reads configuration from your .claude folder.\n` +
      `Edit CLAUDE.md for system prompts and .claude/settings.json for permissions.`,
    { parse_mode: "Markdown" },
  );
}
