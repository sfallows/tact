import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "grammy";
import { getConfig } from "../../config.js";
import { TELEGRAM_MAX_LENGTH } from "../../constants.js";
import { getLogger } from "../../logger.js";

/**
 * /tasks — show open items from tasks.md without starting a Claude session.
 * Reads from config.tasksPath (default: ~/Vault/tasks.md).
 */
export async function tasksHandler(ctx: Context): Promise<void> {
  const logger = getLogger();
  const config = getConfig();
  const vaultPath = config.vaultPath || join(homedir(), "Vault");
  const tasksPath = config.tasksPath || join(vaultPath, "tasks.md");

  let content: string;
  try {
    content = await readFile(tasksPath, "utf-8");
  } catch {
    await ctx.reply(`Could not read tasks file at: ${tasksPath}`);
    return;
  }

  // Extract sections with "Active" or "In Progress" and show open items
  const lines = content.split("\n");

  // Find the Active section
  const activeStart = lines.findIndex((l) =>
    /^#+\s*(active|in.progress)/i.test(l),
  );

  let output: string;
  if (activeStart >= 0) {
    // Collect until next ## heading
    const section: string[] = [lines[activeStart]];
    for (let i = activeStart + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i]) && i !== activeStart) break;
      section.push(lines[i]);
    }
    output = section.join("\n").trim();
  } else {
    // Fall back: just show the whole file
    output = content.trim();
  }

  if (!output) {
    await ctx.reply("No active tasks found.");
    return;
  }

  // Chunk if needed
  if (output.length <= TELEGRAM_MAX_LENGTH - 50) {
    await ctx.reply(output);
  } else {
    // Send first chunk
    await ctx.reply(output.slice(0, TELEGRAM_MAX_LENGTH - 50) + "\n...");
  }

  logger.debug({ path: tasksPath }, "Tasks sent");
}
