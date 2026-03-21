import { join } from "node:path";
import Database from "better-sqlite3";
import type { Bot } from "grammy";
import { appendChatLog } from "../chatlog/index.js";
import { getWorkingDirectory } from "../config.js";
import { getLogger } from "../logger.js";

// --- Types ---

export interface Reminder {
  id: number;
  userId: number;
  chatId: number;
  message: string;
  fireAt: number; // Unix ms
  firedAt: number | null;
}

// --- Constants ---

const DB_FILENAME = "reminders.db";
const POLL_INTERVAL_MS = 30_000;

// --- Module state ---

let db: Database.Database | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let botInstance: Bot | null = null;

// Prepared statements
let stmtInsert: Database.Statement | null = null;
let stmtDue: Database.Statement | null = null;
let stmtMarkFired: Database.Statement | null = null;
let stmtPending: Database.Statement | null = null;

// --- Database ---

function getDbPath(): string {
  return join(getWorkingDirectory(), ".tact", DB_FILENAME);
}

function ensureDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      chat_id    INTEGER NOT NULL,
      message    TEXT    NOT NULL,
      fire_at    INTEGER NOT NULL,
      fired_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_fire_at
      ON reminders (fire_at) WHERE fired_at IS NULL;
  `);

  stmtInsert = db.prepare(`
    INSERT INTO reminders (user_id, chat_id, message, fire_at)
    VALUES (?, ?, ?, ?)
  `);

  stmtDue = db.prepare(`
    SELECT id, user_id, chat_id, message, fire_at, fired_at
    FROM reminders
    WHERE fired_at IS NULL AND fire_at <= ?
    ORDER BY fire_at ASC
  `);

  stmtMarkFired = db.prepare(`
    UPDATE reminders SET fired_at = ? WHERE id = ?
  `);

  stmtPending = db.prepare(`
    SELECT COUNT(*) as count FROM reminders WHERE fired_at IS NULL
  `);

  return db;
}

// --- Public API ---

/**
 * Schedule a new reminder.
 */
export function createReminder(
  userId: number,
  chatId: number,
  message: string,
  fireAt: Date,
): number {
  const _database = ensureDb();
  const result = stmtInsert!.run(userId, chatId, message, fireAt.getTime());
  return result.lastInsertRowid as number;
}

export function getPendingCount(): number {
  try {
    const _database = ensureDb();
    const row = stmtPending!.get() as { count: number };
    return row.count;
  } catch {
    return 0;
  }
}

// --- Poller ---

async function fireDueReminders(): Promise<void> {
  const logger = getLogger();
  if (!botInstance) return;

  let _database: Database.Database;
  try {
    _database = ensureDb();
  } catch (err) {
    logger.warn({ error: err }, "Reminders DB not available");
    return;
  }

  const now = Date.now();
  const due = stmtDue!.all(now) as Array<{
    id: number;
    user_id: number;
    chat_id: number;
    message: string;
    fire_at: number;
  }>;

  for (const row of due) {
    try {
      appendChatLog("reminder", `Reminder: ${row.message}`);
      await botInstance.api.sendMessage(
        row.chat_id,
        `Reminder: ${row.message}`,
      );
      stmtMarkFired!.run(now, row.id);
      logger.info({ id: row.id, message: row.message }, "Reminder fired");
    } catch (err) {
      logger.error({ error: err, id: row.id }, "Failed to fire reminder");
    }
  }
}

export async function startReminderPoller(bot: Bot): Promise<void> {
  const logger = getLogger();
  botInstance = bot;

  // Ensure DB exists on startup
  try {
    ensureDb();
    const pending = getPendingCount();
    if (pending > 0) {
      logger.info({ pending }, "Reminders pending on startup");
    }
  } catch (err) {
    logger.warn({ error: err }, "Could not initialize reminders DB on startup");
  }

  // Fire any reminders that came due while the bot was offline
  await fireDueReminders();

  pollTimer = setInterval(async () => {
    try {
      await fireDueReminders();
    } catch (err) {
      logger.error({ error: err }, "Reminder poll error");
    }
  }, POLL_INTERVAL_MS);

  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Reminder poller started");
}

export function stopReminderPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
  stmtInsert = null;
  stmtDue = null;
  stmtMarkFired = null;
  stmtPending = null;
}
