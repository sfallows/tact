import { exec } from "node:child_process";
import { join, resolve } from "node:path";
import type { Context } from "grammy";
import { getConfig } from "../../config.js";
import { saveSessionId } from "../../user/setup.js";

export async function restartHandler(ctx: Context): Promise<void> {
  const config = getConfig();
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply("Could not identify user.");
    return;
  }

  const userDir = resolve(join(config.dataDir, String(userId)));

  // Clear session before restart so the next boot starts fresh (no poisoned context)
  try {
    await saveSessionId(userDir, null);
  } catch {
    // Non-fatal — restart proceeds regardless
  }

  await ctx.reply("Restarting bot... back in a moment.");

  // Small delay to ensure the reply is sent before we die
  setTimeout(() => {
    exec("systemctl restart tact", () => {
      // Process will be killed by systemd before this runs
    });
  }, 500);
}
