import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "grammy";
import { getWorkingDirectory } from "../../config.js";
import { getLogger } from "../../logger.js";

const MAX_MATCHES = 20;
const MAX_DAYS = 30;

/**
 * /search-log <term> — grep chat log files for a search term.
 * Searches the last 30 days of logs, returns up to 20 matches.
 */
export async function searchLogHandler(ctx: Context): Promise<void> {
  const logger = getLogger();
  const query = (
    typeof ctx.match === "string" ? ctx.match : (ctx.match?.[0] ?? "")
  )
    .trim()
    .toLowerCase();

  if (!query) {
    await ctx.reply("Usage: /search-log <term>");
    return;
  }

  const tactDir = join(getWorkingDirectory(), ".tact");
  let files: string[];
  try {
    files = (await readdir(tactDir))
      .filter((f) => f.startsWith("chat-log-") && f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, MAX_DAYS);
  } catch {
    await ctx.reply("No chat logs found.");
    return;
  }

  const matches: string[] = [];

  for (const file of files) {
    if (matches.length >= MAX_MATCHES) break;
    const date = file.replace("chat-log-", "").replace(".md", "");
    let content: string;
    try {
      content = await readFile(join(tactDir, file), "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(query)) continue;
      // Include the sender line above if present
      const senderLine =
        i > 0 && /^\[\d{2}:\d{2}:\d{2}\]/.test(lines[i - 1])
          ? `${lines[i - 1]} `
          : "";
      const match = `[${date}] ${senderLine}${lines[i].trim()}`;
      matches.push(match);
      if (matches.length >= MAX_MATCHES) break;
    }
  }

  if (matches.length === 0) {
    await ctx.reply(`No matches for "${query}" in the last ${MAX_DAYS} days.`);
    return;
  }

  const header = `${matches.length} match${matches.length !== 1 ? "es" : ""} for "${query}":\n\n`;
  await ctx.reply(header + matches.join("\n"));
  logger.debug({ query, matches: matches.length }, "Log search complete");
}
