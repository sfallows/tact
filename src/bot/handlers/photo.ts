import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "grammy";
import { getConfig } from "../../config.js";
import { MAX_PHOTO_BYTES } from "../../constants.js";
import { getLogger } from "../../logger.js";
import { sendChunkedResponse } from "../../telegram/chunker.js";
import { sendDownloadFiles } from "../../telegram/fileSender.js";
import {
  ensureUserSetup,
  getDownloadsPath,
  getSessionId,
  getUploadsPath,
} from "../../user/setup.js";
import { executeWithRecovery } from "../sessionRecovery.js";

/**
 * Handle photo messages
 */
export async function photoHandler(ctx: Context): Promise<void> {
  const config = getConfig();
  const logger = getLogger();
  const userId = ctx.from?.id;
  const photo = ctx.message?.photo;
  const rawCaption = ctx.message?.caption || "";
  const isBusinessCard =
    /business.?card|contact.?card|biz.?card/i.test(rawCaption) ||
    (!rawCaption && false);
  const caption = isBusinessCard
    ? "This is a business card. Please extract all contact information from it (name, title, company, phone, email, website, address) and add it as a new contact in Google Contacts using the contacts MCP tool. Confirm what was saved."
    : rawCaption || "Please analyze this image.";

  if (!userId || !photo || photo.length === 0) {
    return;
  }

  // Check file size before downloading
  const largestPhoto = photo[photo.length - 1];
  if (largestPhoto.file_size && largestPhoto.file_size > MAX_PHOTO_BYTES) {
    await ctx.reply(
      `Image too large (${(largestPhoto.file_size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`,
    );
    return;
  }

  logger.debug({ userId }, "Photo received");

  const userDir = resolve(join(config.dataDir, String(userId)));

  try {
    ctx.replyWithChatAction("typing").catch(() => {});

    await ensureUserSetup(userDir);

    const file = await ctx.api.getFile(largestPhoto.file_id);
    const filePath = file.file_path;

    if (!filePath) {
      await ctx.reply("Could not download the image.");
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${filePath}`;
    const downloadAc = new AbortController();
    const downloadTimeout = setTimeout(() => downloadAc.abort(), 30000);
    const response = await fetch(fileUrl, {
      signal: downloadAc.signal,
    }).finally(() => clearTimeout(downloadTimeout));
    if (!response.ok) {
      await ctx.reply(
        `Failed to download image from Telegram (HTTP ${response.status}).`,
      );
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const ext = filePath.split(".").pop() || "jpg";
    const imageName = `image_${randomUUID()}.${ext}`;
    const uploadsDir = getUploadsPath(userDir);
    const imagePath = join(uploadsDir, imageName);
    await writeFile(imagePath, buffer);

    logger.debug({ path: imagePath }, "Image saved");

    const prompt = `Please look at the image file "./uploads/${imageName}" and ${caption}`;
    const sessionId = await getSessionId(userDir);

    const statusMsg = await ctx.reply("_Processing..._", {
      parse_mode: "Markdown",
    });
    let lastProgressUpdate = Date.now();
    let lastProgressText = "Processing...";

    const onProgress = async (message: string) => {
      const now = Date.now();
      if (now - lastProgressUpdate > 2000 && message !== lastProgressText) {
        lastProgressUpdate = now;
        lastProgressText = message;
        try {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            statusMsg.message_id,
            `_${message}_`,
            { parse_mode: "Markdown" },
          );
        } catch {
          // Ignore edit errors
        }
      }
    };

    const downloadsPath = getDownloadsPath(userDir);

    logger.debug("Executing Claude query with image");
    const parsed = await executeWithRecovery(
      { prompt, userDir, downloadsPath, onProgress },
      sessionId,
    );

    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {
      // Ignore delete errors
    }

    await sendChunkedResponse(ctx, parsed.text);

    const filesSent = await sendDownloadFiles(ctx, userDir);
    if (filesSent > 0) {
      logger.info({ filesSent }, "Sent download files to user");
    }
  } catch (error) {
    logger.error({ error }, "Photo handler error");
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    await ctx.reply(`An error occurred processing the image: ${errorMessage}`);
  }
}
