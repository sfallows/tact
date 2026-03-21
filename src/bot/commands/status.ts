import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "grammy";
import {
  getLastExitCode,
  getLastInvokedAt,
  isClaudeBusy,
} from "../../claude/executor.js";
import { getWorkingDirectory } from "../../config.js";
import { getNotificationQueueStats } from "../../notification/queue.js";
import { getPendingCount } from "../../reminder/index.js";
import { getWebhookQueueStats } from "../../webhook/queue.js";

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

interface Heartbeat {
  lastMessageReceived?: number;
  lastReplySent?: number | null;
  status?: string;
}

export async function statusHandler(ctx: Context): Promise<void> {
  const uptime = formatUptime(process.uptime());
  const claudeState = isClaudeBusy() ? "busy" : "idle";
  const webhookStats = getWebhookQueueStats();
  const notifStats = getNotificationQueueStats();
  const reminderPending = getPendingCount();
  const lastExitCode = getLastExitCode();
  const lastInvokedAt = getLastInvokedAt();

  // Read heartbeat for last message/reply times
  let lastMsg = "";
  let lastReply = "";
  try {
    const heartbeatPath = join(
      getWorkingDirectory(),
      ".tact",
      "heartbeat.json",
    );
    const raw = await readFile(heartbeatPath, "utf-8");
    const hb = JSON.parse(raw) as Heartbeat;
    if (hb.lastMessageReceived) {
      lastMsg = formatRelativeTime(hb.lastMessageReceived);
    }
    if (hb.lastReplySent) {
      lastReply = formatRelativeTime(hb.lastReplySent);
    }
  } catch {
    // No heartbeat yet
  }

  const lines = [
    "Bot status",
    "",
    `Uptime: ${uptime}`,
    `Claude: ${claudeState}`,
  ];

  if (lastMsg) lines.push(`Last message: ${lastMsg}`);
  if (lastReply) lines.push(`Last reply: ${lastReply}`);
  if (lastInvokedAt) {
    const exitStr =
      lastExitCode === null
        ? "?"
        : lastExitCode === 0
          ? "ok"
          : `exit ${lastExitCode}`;
    lines.push(
      `Last Claude call: ${formatRelativeTime(lastInvokedAt)} (${exitStr})`,
    );
  }

  lines.push(
    "",
    `Webhook queue: ${webhookStats.pending} pending`,
    `Notification queue: ${notifStats.pending} pending`,
    `Reminders pending: ${reminderPending}`,
  );

  await ctx.reply(lines.join("\n"));
}
