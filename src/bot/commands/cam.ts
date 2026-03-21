import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import { getLogger } from "../../logger.js";

const execFileAsync = promisify(execFile);

/**
 * /cam — capture the current quint screen and send as a photo
 */
export async function camHandler(ctx: Context): Promise<void> {
  const logger = getLogger();
  const screenshotPath = join("/tmp", `tact-screenshot-${randomUUID()}.png`);

  const statusMsg = await ctx.reply("_Capturing screen..._", {
    parse_mode: "Markdown",
  });

  try {
    // -x = no sound effect, -t 0 = no delay
    await execFileAsync("screencapture", ["-x", "-t", "png", screenshotPath]);

    if (!existsSync(screenshotPath)) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        "Screenshot failed — file not created.",
      );
      return;
    }

    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {
      /* ignore */
    }

    await ctx.replyWithPhoto(new InputFile(screenshotPath));
    logger.info("Screenshot sent");
  } catch (err) {
    logger.error({ error: err }, "Screenshot error");
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `Screenshot failed: ${msg}`,
      );
    } catch {
      await ctx.reply(`Screenshot failed: ${msg}`);
    }
  } finally {
    try {
      if (existsSync(screenshotPath)) unlinkSync(screenshotPath);
    } catch {
      /* ignore */
    }
  }
}
