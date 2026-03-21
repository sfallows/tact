import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "grammy";
import { getConfig } from "../../config.js";
import { getLogger } from "../../logger.js";

/**
 * /note <text> — append a quick note to today's Vault notes file.
 * No Claude involved — instant, fire-and-done.
 */
export async function noteHandler(ctx: Context): Promise<void> {
  const logger = getLogger();
  const config = getConfig();
  const tz = config.timezone;

  const note = (
    typeof ctx.match === "string" ? ctx.match : (ctx.match?.[0] ?? "")
  ).trim();

  if (!note) {
    await ctx.reply("Usage: /note <text>");
    return;
  }

  const vaultPath = config.vaultPath || join(homedir(), "Vault");
  const date = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const notesPath = join(vaultPath, "notes", `${date}.md`);

  const time = new Date().toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  try {
    await mkdir(dirname(notesPath), { recursive: true });
    await appendFile(notesPath, `- [${time}] ${note}\n`, "utf-8");
    await ctx.reply(`Note saved.`);
    logger.info({ path: notesPath }, "Note appended");
  } catch (err) {
    logger.error({ error: err }, "Failed to save note");
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Failed to save note: ${msg}`);
  }
}
