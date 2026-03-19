import type { Context } from "grammy";
import { getLogger } from "../logger.js";

interface BufferedMessage {
  text: string;
  ctx: Context;
  timestamp: number;
}

interface UserBuffer {
  messages: BufferedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  processing: boolean;
}

type MessageProcessor = (ctx: Context, combinedText: string) => Promise<void>;

const userBuffers = new Map<number, UserBuffer>();
const MAX_BUFFER_MESSAGES = 20;

let bufferDelayMs = 0;
let processor: MessageProcessor | null = null;

/**
 * Initialize the message buffer with delay and processor function
 */
export function initMessageBuffer(
  delayMs: number,
  processFunc: MessageProcessor,
): void {
  bufferDelayMs = delayMs;
  processor = processFunc;
}

/**
 * Get or create buffer for a user
 */
function getBuffer(userId: number): UserBuffer {
  let buffer = userBuffers.get(userId);
  if (!buffer) {
    buffer = { messages: [], timer: null, processing: false };
    userBuffers.set(userId, buffer);
  }
  return buffer;
}

/**
 * Flush the buffer — combine messages and process
 */
async function flushBuffer(userId: number): Promise<void> {
  const logger = getLogger();
  const buffer = getBuffer(userId);

  if (buffer.messages.length === 0 || buffer.processing || !processor) {
    return;
  }

  buffer.processing = true;
  buffer.timer = null;

  // Take all messages and clear the buffer
  const messages = [...buffer.messages];
  buffer.messages = [];

  // Use the most recent context for the reply
  const latestCtx = messages[messages.length - 1].ctx;

  // Combine message texts
  const combinedText =
    messages.length === 1
      ? messages[0].text
      : messages.map((m) => m.text).join("\n\n");

  if (messages.length > 1) {
    logger.info(
      { userId, messageCount: messages.length },
      "Combined buffered messages",
    );
  }

  try {
    await processor(latestCtx, combinedText);
  } finally {
    buffer.processing = false;

    // If new messages arrived while processing, flush again
    if (buffer.messages.length > 0) {
      await flushBuffer(userId);
    }
  }
}

/**
 * Add a message to the buffer. If buffering is disabled (delay=0),
 * processes immediately.
 */
export async function bufferMessage(
  ctx: Context,
  messageText: string,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !processor) return;

  // If buffering is disabled, process immediately
  if (bufferDelayMs <= 0) {
    await processor(ctx, messageText);
    return;
  }

  const buffer = getBuffer(userId);

  // Drop messages beyond the cap to prevent unbounded memory growth
  if (buffer.messages.length >= MAX_BUFFER_MESSAGES) {
    const logger = getLogger();
    logger.warn(
      { userId, buffered: buffer.messages.length },
      "Message buffer full — dropping oldest message",
    );
    buffer.messages.shift();
  }

  buffer.messages.push({
    text: messageText,
    ctx,
    timestamp: Date.now(),
  });

  // Reset the timer — each new message extends the window
  if (buffer.timer) {
    clearTimeout(buffer.timer);
  }

  const logger = getLogger();
  logger.debug(
    { userId, buffered: buffer.messages.length, delayMs: bufferDelayMs },
    "Message buffered",
  );

  buffer.timer = setTimeout(() => {
    flushBuffer(userId).catch((err) => {
      logger.error({ error: err, userId }, "Buffer flush error");
    });
  }, bufferDelayMs);
}
