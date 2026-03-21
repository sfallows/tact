import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "grammy";
import { getConfig } from "../../config.js";
import {
  MAX_DOCUMENT_BYTES,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_MIME_TYPES,
} from "../../constants.js";
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
 * Handle document messages (PDFs, images, code files, etc.)
 */
export async function documentHandler(ctx: Context): Promise<void> {
  const config = getConfig();
  const logger = getLogger();
  const userId = ctx.from?.id;
  const document = ctx.message?.document;
  const caption = ctx.message?.caption || "Please analyze this document.";

  if (!userId || !document) {
    return;
  }

  const mimeType = document.mime_type || "";
  const fileName = document.file_name || "document";
  const dotIndex = fileName.lastIndexOf(".");
  const ext = dotIndex > 0 ? fileName.slice(dotIndex).toLowerCase() : "";

  const isSupported =
    SUPPORTED_MIME_TYPES.includes(mimeType) ||
    SUPPORTED_EXTENSIONS.includes(ext);

  if (!isSupported) {
    await ctx.reply(
      "Unsupported file type. Supported: PDF, images, text, and code files.",
    );
    return;
  }

  // Check file size before downloading
  if (document.file_size && document.file_size > MAX_DOCUMENT_BYTES) {
    await ctx.reply(
      `File too large (${(document.file_size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`,
    );
    return;
  }

  logger.debug({ fileName, mimeType }, "Document received");

  const userDir = resolve(join(config.dataDir, String(userId)));

  try {
    ctx.replyWithChatAction("typing").catch(() => {});

    await ensureUserSetup(userDir);

    const file = await ctx.api.getFile(document.file_id);
    const filePath = file.file_path;

    if (!filePath) {
      await ctx.reply("Could not download the document.");
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
        `Failed to download file from Telegram (HTTP ${response.status}).`,
      );
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniqueName = `${randomUUID()}_${safeName}`;
    const uploadsDir = getUploadsPath(userDir);
    const docPath = join(uploadsDir, uniqueName);
    await writeFile(docPath, buffer);

    logger.debug({ path: docPath }, "Document saved");

    const prompt = `Please read the file "./uploads/${uniqueName}" and ${caption}`;
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

    logger.debug("Executing Claude query with document");
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
    logger.error({ error }, "Document handler error");
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    await ctx.reply(
      `An error occurred processing the document: ${errorMessage}`,
    );
  }
}
