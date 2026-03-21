import type { Context } from "grammy";
import { processMessage } from "../handlers/text.js";

/**
 * /search <query> — quick web search via Claude (no session overhead)
 */
export async function searchHandler(ctx: Context): Promise<void> {
  const query = (
    typeof ctx.match === "string" ? ctx.match : (ctx.match?.[0] ?? "")
  ).trim();

  if (!query) {
    await ctx.reply("Usage: /search <query>");
    return;
  }

  await processMessage(
    ctx,
    `Please search the web for: ${query}\n\nReturn a concise summary of the most relevant results.`,
  );
}
