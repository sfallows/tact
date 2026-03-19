import type { Context } from "grammy";
import { isClaudeBusy } from "../../claude/executor.js";
import { getNotificationQueueStats } from "../../notification/queue.js";
import { getWebhookQueueStats } from "../../webhook/queue.js";

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}m ${s}s`;
}

export async function statusHandler(ctx: Context): Promise<void> {
  const uptime = formatUptime(process.uptime());
  const claudeState = isClaudeBusy() ? "busy" : "idle";
  const webhookStats = getWebhookQueueStats();
  const notifStats = getNotificationQueueStats();

  const text = [
    "Bot status",
    "",
    `Uptime: ${uptime}`,
    `Claude: ${claudeState}`,
    `Webhook queue: ${webhookStats.pending} pending`,
    `Notification queue: ${notifStats.pending} pending`,
  ].join("\n");

  await ctx.reply(text);
}
