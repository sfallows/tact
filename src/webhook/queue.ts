import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bot } from "grammy";
import { executeClaudeQuery, isClaudeBusy } from "../claude/executor.js";
import { getConfig, getWorkingDirectory } from "../config.js";
import { getLogger } from "../logger.js";
import {
  ensureUserSetup,
  getDownloadsPath,
  getSessionId,
  saveSessionId,
} from "../user/setup.js";

// --- Types ---

export interface WebhookQueueItem {
  id: string;
  contentHash: string;
  message: string;
  notify: boolean;
  timestamp: number;
  status: "pending" | "processing";
  retries: number;
}

interface EnqueueResult {
  id: string;
  position: number;
  duplicate: boolean;
}

// --- Constants ---

const QUEUE_FILENAME = "webhook-queue.json";
const MAX_QUEUE_DEPTH = 50;
const POLL_INTERVAL_MS = 12_000;
const ITEM_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_RETRIES = 3;

// --- Module state ---

let queueFilePath: string;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let botInstance: Bot | null = null;
let processing = false;

// --- File-level mutex (prevents concurrent read-modify-write) ---
let _lockPromise: Promise<void> = Promise.resolve();

function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _lockPromise;
  let releaseLock: () => void;
  _lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  return prev.then(fn).finally(() => releaseLock!());
}

// --- Queue file I/O ---

function getQueuePath(): string {
  if (!queueFilePath) {
    const tactDir = join(getWorkingDirectory(), ".tact");
    queueFilePath = join(tactDir, QUEUE_FILENAME);
  }
  return queueFilePath;
}

async function readQueue(): Promise<WebhookQueueItem[]> {
  const path = getQueuePath();
  try {
    const data = await readFile(path, "utf-8");
    return JSON.parse(data) as WebhookQueueItem[];
  } catch (err) {
    // Log if file exists but failed to parse (corruption)
    if (existsSync(path)) {
      const logger = getLogger();
      logger.warn(
        { error: err, path },
        "Queue file exists but failed to parse — treating as empty",
      );
    }
    return [];
  }
}

async function writeQueue(items: WebhookQueueItem[]): Promise<void> {
  const path = getQueuePath();
  const dir = join(getWorkingDirectory(), ".tact");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  // Atomic write: write to temp file then rename (prevents corruption on crash)
  const tmpPath = path + ".tmp";
  await writeFile(tmpPath, JSON.stringify(items, null, 2), "utf-8");
  await rename(tmpPath, path);
}

// --- Hashing for dedup ---

function hashMessage(message: string): string {
  return createHash("sha256").update(message).digest("hex").slice(0, 16);
}

// --- Public API ---

export class QueueFullError extends Error {
  depth: number;
  constructor(depth: number) {
    super(`Queue full (${depth} items)`);
    this.name = "QueueFullError";
    this.depth = depth;
  }
}

export function enqueue(
  message: string,
  notify: boolean,
): Promise<EnqueueResult> {
  return withFileLock(async () => {
    const queue = await readQueue();
    const contentHash = hashMessage(message);

    // Dedup: if a pending item with same hash exists, return it
    const pendingItems = queue.filter((i) => i.status === "pending");
    const existing = pendingItems.find(
      (item) => item.contentHash === contentHash,
    );
    if (existing) {
      const position = pendingItems.indexOf(existing) + 1;
      return { id: existing.id, position, duplicate: true };
    }

    // Max depth check
    if (queue.length >= MAX_QUEUE_DEPTH) {
      throw new QueueFullError(queue.length);
    }

    const item: WebhookQueueItem = {
      id: randomUUID(),
      contentHash,
      message,
      notify,
      timestamp: Date.now(),
      status: "pending",
      retries: 0,
    };

    queue.push(item);
    await writeQueue(queue);

    const position = queue.filter((i) => i.status === "pending").length;
    return { id: item.id, position, duplicate: false };
  });
}

/**
 * Process the next pending item in the queue.
 * Returns true if an item was processed, false if queue was empty or Claude busy.
 */
export async function drainQueue(): Promise<boolean> {
  const logger = getLogger();

  if (processing) {
    return false;
  }

  if (isClaudeBusy()) {
    return false;
  }

  // Claim next pending item under lock; also prune expired items
  const claimed = await withFileLock(async () => {
    const queue = await readQueue();
    const now = Date.now();
    let changed = false;

    // Remove expired items (TTL exceeded)
    const active: WebhookQueueItem[] = [];
    for (const item of queue) {
      if (now - item.timestamp > ITEM_TTL_MS && item.status === "pending") {
        logger.warn(
          {
            queueId: item.id,
            ageMin: Math.round((now - item.timestamp) / 60000),
          },
          "Dropping expired queue item (TTL exceeded)",
        );
        changed = true;
      } else {
        active.push(item);
      }
    }

    const nextItem = active.find((item) => item.status === "pending");
    if (!nextItem) {
      if (changed) await writeQueue(active);
      return null;
    }

    nextItem.status = "processing";
    await writeQueue(active);
    return nextItem;
  });

  if (!claimed) return false;

  processing = true;

  try {
    logger.info(
      { queueId: claimed.id, notify: claimed.notify, retries: claimed.retries },
      "Processing queued webhook",
    );

    const config = getConfig();
    const primaryUserId = config.access.allowedUserIds[0];
    const userDir = join(config.dataDir, String(primaryUserId));
    await ensureUserSetup(userDir);

    const sessionId = await getSessionId(userDir);
    const downloadsPath = getDownloadsPath(userDir);

    const result = await executeClaudeQuery({
      prompt: claimed.message,
      userDir,
      downloadsPath,
      sessionId,
    });

    // Save session
    if (result.sessionId) {
      await saveSessionId(userDir, result.sessionId);
    }

    // Send to Telegram if notify
    let sendFailed = false;
    if (claimed.notify && botInstance && result.output) {
      try {
        const text = result.success
          ? result.output
          : result.error || "An error occurred processing queued webhook";
        const chunks = splitText(text, 4000);
        for (const chunk of chunks) {
          await botInstance.api.sendMessage(primaryUserId, chunk);
        }
      } catch (err) {
        sendFailed = true;
        logger.error(
          { error: err, queueId: claimed.id },
          "Failed to send queued result to Telegram",
        );
      }
    }

    // If Telegram send failed, requeue for retry (keep the Claude result logged)
    if (sendFailed) {
      await withFileLock(async () => {
        const updatedQueue = await readQueue();
        const item = updatedQueue.find((i) => i.id === claimed.id);
        if (item) {
          item.retries = (item.retries || 0) + 1;
          if (item.retries >= MAX_RETRIES) {
            logger.error(
              { queueId: claimed.id, retries: item.retries },
              "Webhook item failed after max retries — dropping",
            );
            const filtered = updatedQueue.filter((i) => i.id !== claimed.id);
            await writeQueue(filtered);
          } else {
            item.status = "pending";
            await writeQueue(updatedQueue);
            logger.warn(
              { queueId: claimed.id, retries: item.retries },
              "Requeued webhook item for retry",
            );
          }
        }
      });
      return true;
    }

    // Remove processed item under lock
    await withFileLock(async () => {
      const updatedQueue = (await readQueue()).filter(
        (i) => i.id !== claimed.id,
      );
      await writeQueue(updatedQueue);
    });

    logger.info(
      { queueId: claimed.id, success: result.success },
      "Queued webhook processed",
    );
    return true;
  } catch (err) {
    logger.error(
      { error: err, queueId: claimed.id },
      "Error processing queued webhook",
    );

    // Retry on failure instead of dropping
    await withFileLock(async () => {
      const updatedQueue = await readQueue();
      const item = updatedQueue.find((i) => i.id === claimed.id);
      if (item) {
        item.retries = (item.retries || 0) + 1;
        if (item.retries >= MAX_RETRIES) {
          logger.error(
            { queueId: claimed.id, retries: item.retries },
            "Webhook item failed after max retries — dropping",
          );
          // Notify via Telegram that a webhook was permanently lost
          if (botInstance) {
            const config = getConfig();
            const primaryUserId = config.access.allowedUserIds[0];
            try {
              const preview = claimed.message.slice(0, 100);
              await botInstance.api.sendMessage(
                primaryUserId,
                `\u26a0\ufe0f Webhook message failed after ${MAX_RETRIES} retries and was dropped:\n\n${preview}...`,
              );
            } catch {
              // Can't notify — just log
            }
          }
          const filtered = updatedQueue.filter((i) => i.id !== claimed.id);
          await writeQueue(filtered);
        } else {
          item.status = "pending";
          await writeQueue(updatedQueue);
          logger.warn(
            { queueId: claimed.id, retries: item.retries },
            "Requeued failed webhook item for retry",
          );
        }
      }
    });

    return false;
  } finally {
    processing = false;
  }
}

/**
 * Drain all pending items sequentially (called after text handler finishes).
 */
export async function drainAll(): Promise<void> {
  while (await drainQueue()) {
    // Keep processing until queue is empty or Claude becomes busy
  }
}

// --- Poller lifecycle ---

export async function startQueuePoller(bot: Bot): Promise<void> {
  const logger = getLogger();
  botInstance = bot;

  // Recovery: reset any stuck "processing" items from previous run
  await withFileLock(async () => {
    const queue = await readQueue();
    let recovered = 0;
    for (const item of queue) {
      if (item.status === "processing") {
        item.status = "pending";
        recovered++;
      }
    }
    if (recovered > 0) {
      await writeQueue(queue);
      logger.info({ recovered }, "Reset stuck queue items to pending");
    }
    if (queue.length > 0) {
      logger.info(
        { pending: queue.filter((i) => i.status === "pending").length },
        "Queue items pending on startup",
      );
    }
  });

  pollTimer = setInterval(async () => {
    try {
      await drainQueue();
    } catch (err) {
      logger.error({ error: err }, "Queue poll error");
    }
  }, POLL_INTERVAL_MS);

  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Webhook queue poller started");
}

export function stopQueuePoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// --- Helper ---

function splitText(text: string, maxLen: number): string[] {
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
