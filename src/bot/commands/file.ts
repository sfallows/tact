import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "grammy";
import { getConfig } from "../../config.js";
import { getDownloadsPath } from "../../user/setup.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * /file — list files in the user's downloads folder without invoking Claude.
 */
export async function fileHandler(ctx: Context): Promise<void> {
  const config = getConfig();
  const userId = ctx.from?.id;
  if (!userId) return;

  const userDir = resolve(join(config.dataDir, String(userId)));
  const downloadsPath = getDownloadsPath(userDir);

  let entries: string[];
  try {
    entries = (await readdir(downloadsPath)).filter((f) => !f.startsWith("."));
  } catch {
    await ctx.reply("Downloads folder is empty.");
    return;
  }

  if (entries.length === 0) {
    await ctx.reply("Downloads folder is empty.");
    return;
  }

  const lines = await Promise.all(
    entries.map(async (name) => {
      try {
        const s = await stat(join(downloadsPath, name));
        return `- ${name} (${formatBytes(s.size)})`;
      } catch {
        return `- ${name}`;
      }
    }),
  );

  await ctx.reply(`Downloads (${entries.length}):\n${lines.join("\n")}`);
}
