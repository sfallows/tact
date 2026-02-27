/**
 * Notification Queue — SQLite-backed outbound Telegram message queue.
 *
 * Drains pending notifications and sends them via Telegram bot API.
 * Runs alongside the webhook queue on the same 12s poll cycle.
 *
 * Notifications are enqueued externally via notify.sh / notify.py,
 * which insert rows into .ccpa/notifications.db.
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Bot } from "grammy";
import { getConfig, getWorkingDirectory } from "../config.js";
import { isClaudeBusy } from "../claude/executor.js";
import { getLogger } from "../logger.js";

// --- Types ---

interface NotificationRow {
  id: number;
  priority: number;
  source: string;
  payload: string;
  status: string;
  created_at: string;
  attempts: number;
  max_attempts: number;
}

// --- Constants ---

const DB_FILENAME = "notifications.db";
const SIGNAL_FILENAME = "notify-signal";
const POLL_INTERVAL_MS = 12_000;

// --- Module state ---

let db: Database.Database | null = null;
let botInstance: Bot | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let primaryUserId: number | null = null;

// Prepared statements (cached for performance)
let stmtClaim: Database.Statement | null = null;
let stmtMarkSent: Database.Statement | null = null;
let stmtMarkFailed: Database.Statement | null = null;
let stmtRequeue: Database.Statement | null = null;
let stmtPendingCount: Database.Statement | null = null;

// --- Database ---

function getDbPath(): string {
  return join(getWorkingDirectory(), ".ccpa", DB_FILENAME);
}

function getSignalPath(): string {
  return join(getWorkingDirectory(), ".ccpa", SIGNAL_FILENAME);
}

function ensureDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    throw new Error("notifications.db not found");
  }

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");

  // Atomic claim: find next pending, mark as processing, return it
  stmtClaim = db.prepare(`
    UPDATE notifications
    SET status = 'processing', attempts = attempts + 1
    WHERE id = (
      SELECT id FROM notifications
      WHERE status = 'pending'
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    )
    RETURNING id, priority, source, payload, status, created_at, attempts, max_attempts
  `);

  stmtMarkSent = db.prepare(`
    UPDATE notifications
    SET status = 'sent', sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `);

  stmtMarkFailed = db.prepare(`
    UPDATE notifications SET status = 'failed', error = ? WHERE id = ?
  `);

  stmtRequeue = db.prepare(`
    UPDATE notifications SET status = 'pending', error = ? WHERE id = ?
  `);

  stmtPendingCount = db.prepare(`
    SELECT COUNT(*) as count FROM notifications WHERE status = 'pending'
  `);

  return db;
}

// --- Signal file ---

function checkAndClearSignal(): boolean {
  const signalPath = getSignalPath();
  try {
    if (existsSync(signalPath)) {
      unlinkSync(signalPath);
      return true;
    }
  } catch {
    // Non-fatal
  }
  return false;
}

// --- Drain logic ---

/**
 * Drain one notification from the queue.
 * Returns true if a message was sent, false if nothing to do.
 */
export async function drainNotification(): Promise<boolean> {
  const logger = getLogger();

  if (!botInstance || !primaryUserId) return false;

  if (isClaudeBusy()) return false;

  try {
    ensureDb();
  } catch {
    return false;
  }

  // Atomic claim-and-read
  const row = stmtClaim!.get() as NotificationRow | undefined;
  if (!row) return false;

  logger.info(
    { notifId: row.id, priority: row.priority, source: row.source, attempt: row.attempts },
    "Draining notification",
  );

  try {
    const chunks = splitMessage(row.payload, 4000);
    for (const chunk of chunks) {
      await botInstance.api.sendMessage(primaryUserId, chunk);
    }

    stmtMarkSent!.run(row.id);
    logger.info(
      { notifId: row.id, source: row.source },
      "Notification sent",
    );
    return true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (row.attempts >= row.max_attempts) {
      stmtMarkFailed!.run(errorMsg, row.id);
      logger.error(
        { notifId: row.id, source: row.source, attempts: row.attempts, error: errorMsg },
        "Notification failed permanently",
      );
    } else {
      stmtRequeue!.run(errorMsg, row.id);
      logger.warn(
        { notifId: row.id, source: row.source, attempts: row.attempts, error: errorMsg },
        "Notification requeued for retry",
      );
    }
    return false;
  }
}

/**
 * Drain all pending notifications sequentially.
 */
export async function drainAllNotifications(): Promise<void> {
  let sent = 0;
  while (await drainNotification()) {
    sent++;
    // Brief pause between messages to respect Telegram rate limits (1 msg/s per chat)
    if (sent > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }
}

// --- Lifecycle ---

export async function startNotificationPoller(bot: Bot): Promise<void> {
  const logger = getLogger();
  const config = getConfig();
  botInstance = bot;
  primaryUserId = config.access.allowedUserIds[0];

  if (!primaryUserId) {
    logger.warn("No allowed users — notification poller disabled");
    return;
  }

  // Recovery: reset stuck "processing" items from previous crash
  try {
    const database = ensureDb();
    const result = database.prepare(`
      UPDATE notifications SET status = 'pending'
      WHERE status = 'processing'
    `).run();
    if (result.changes > 0) {
      logger.info({ recovered: result.changes }, "Reset stuck notification items to pending");
    }
    const pending = stmtPendingCount!.get() as { count: number };
    if (pending.count > 0) {
      logger.info({ pending: pending.count }, "Notification items pending on startup");
    }
  } catch {
    logger.debug("Notifications DB not found on startup — will check on poll");
  }

  pollTimer = setInterval(async () => {
    try {
      const signaled = checkAndClearSignal();
      if (signaled) {
        logger.info("Notification signal detected — immediate drain");
      }

      await drainAllNotifications();
    } catch (err) {
      logger.error({ error: err }, "Notification poll error");
    }
  }, POLL_INTERVAL_MS);

  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Notification queue poller started");
}

export function stopNotificationPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
}

// --- Helper ---

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let split = remaining.lastIndexOf("\n\n", maxLen);
    if (split < maxLen * 0.5) split = remaining.lastIndexOf("\n", maxLen);
    if (split < maxLen * 0.5) split = remaining.lastIndexOf(" ", maxLen);
    if (split < maxLen * 0.5) split = maxLen;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  return chunks;
}
