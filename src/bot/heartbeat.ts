import type { Context } from "grammy";

/**
 * Start a heartbeat interval that edits a Telegram status message every 15s
 * when there has been no recent progress update.
 *
 * Returns a stop function. Call it after Claude finishes to clear the interval.
 *
 * @param getState - Called on each tick to read fresh progress state
 */
export function startHeartbeat(
  ctx: Context,
  chatId: number,
  statusMsgId: number,
  getState: () => {
    lastProgressUpdate: number;
    lastProgressText: string;
    processStart: number;
  },
): () => void {
  const id = setInterval(async () => {
    const { lastProgressUpdate, lastProgressText, processStart } = getState();
    if (Date.now() - lastProgressUpdate < 12000) return;
    const elapsed = Math.round((Date.now() - processStart) / 1000);
    const label = lastProgressText ? `${lastProgressText} ` : "Working ";
    try {
      await ctx.api.editMessageText(
        chatId,
        statusMsgId,
        `_${label}(${elapsed}s)_`,
        { parse_mode: "Markdown" },
      );
    } catch {
      // Ignore edit errors
    }
  }, 15000);

  return () => clearInterval(id);
}
