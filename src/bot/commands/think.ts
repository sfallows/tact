import { join, resolve } from "node:path";
import type { Context } from "grammy";
import { executeClaudeQuery, isClaudeBusy } from "../../claude/executor.js";
import { getConfig } from "../../config.js";
import { TELEGRAM_MAX_LENGTH } from "../../constants.js";
import { getLogger } from "../../logger.js";
import { ensureUserSetup, getDownloadsPath } from "../../user/setup.js";

const THINK_SYSTEM_PROMPT = `You are in DEEP REASONING MODE. Your task is to think carefully and thoroughly about the question before answering.

Approach:
1. Restate the core question in your own words
2. Identify key considerations, constraints, and trade-offs
3. Reason through each aspect systematically
4. Consider second-order effects and edge cases
5. Arrive at a well-justified conclusion

Be explicit about your reasoning. Show your work. This is for important decisions — accuracy matters more than brevity.`;

const REVIEW_SYSTEM_PROMPT = `You are a critical peer reviewer. You will be given a question and a proposed answer/analysis.

Your job:
1. Identify any flaws, gaps, or weak reasoning in the analysis
2. Note any important considerations that were missed
3. Point out any assumptions that should be questioned
4. Confirm what the analysis got right
5. Provide a revised conclusion if warranted, or confirm the original if sound

Be direct and specific. Don't be polite at the expense of accuracy.`;

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, TELEGRAM_MAX_LENGTH));
    remaining = remaining.slice(TELEGRAM_MAX_LENGTH);
  }
  return chunks;
}

export async function thinkHandler(ctx: Context): Promise<void> {
  const config = getConfig();
  const logger = getLogger();
  const userId = ctx.from?.id;

  if (!userId) return;

  const question = (
    typeof ctx.match === "string" ? ctx.match : (ctx.match?.[0] ?? "")
  ).trim();

  if (!question) {
    await ctx.reply(
      "Usage: /think <question or topic>\n\nExample: /think Should I migrate the Pi to HDD now or wait for the fix plan?",
    );
    return;
  }

  if (isClaudeBusy()) {
    await ctx.reply(
      "Claude is busy with another request. Please wait a moment and try again.",
    );
    return;
  }

  const userDir = resolve(join(config.dataDir, String(userId)));
  await ensureUserSetup(userDir);
  const downloadsPath = getDownloadsPath(userDir);

  // Status message
  const statusMsg = await ctx.reply("Thinking deeply... (phase 1/2)");
  const chatId = ctx.chat!.id;
  const statusMsgId = statusMsg.message_id;

  const editStatus = async (text: string) => {
    try {
      await ctx.api.editMessageText(chatId, statusMsgId, text);
    } catch {
      /* ignore */
    }
  };

  logger.info({ userId, question }, "/think command triggered");

  // --- Phase 1: Deep reasoning ---
  const reasoningPrompt = `${THINK_SYSTEM_PROMPT}\n\n---\n\nQuestion: ${question}`;

  let reasoningResult = "";
  try {
    const r1 = await executeClaudeQuery({
      prompt: reasoningPrompt,
      userDir,
      downloadsPath,
      sessionId: null,
      effort: "high",
      onProgress: (msg) => {
        logger.debug({ msg }, "Think phase 1 progress");
      },
      onTextChunk: (text) => {
        reasoningResult = text;
      },
    });

    if (!r1.success || !r1.output) {
      await editStatus(`Reasoning phase failed: ${r1.error ?? "no output"}`);
      return;
    }
    reasoningResult = r1.output;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await editStatus(`Error in reasoning phase: ${msg}`);
    return;
  }

  // --- Phase 2: Peer review ---
  await editStatus("Thinking deeply... (phase 2/2 - peer review)");

  const reviewPrompt =
    REVIEW_SYSTEM_PROMPT +
    "\n\n---\n\nOriginal question: " +
    question +
    "\n\nProposed analysis:\n" +
    reasoningResult;

  let reviewResult = "";
  try {
    const r2 = await executeClaudeQuery({
      prompt: reviewPrompt,
      userDir,
      downloadsPath,
      sessionId: null,
      effort: "high",
      onProgress: (msg) => {
        logger.debug({ msg }, "Think phase 2 progress");
      },
      onTextChunk: (text) => {
        reviewResult = text;
      },
    });

    if (!r2.success || !r2.output) {
      reviewResult = `(Peer review failed: ${r2.error ?? "no output"})`;
    } else {
      reviewResult = r2.output;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reviewResult = `(Peer review error: ${msg})`;
  }

  // Delete status message
  try {
    await ctx.api.deleteMessage(chatId, statusMsgId);
  } catch {
    /* ignore */
  }

  // Send inline — split into chunks if needed
  const fullText =
    "Deep Analysis:\n\n" +
    reasoningResult +
    "\n\n---\n\nPeer Review:\n\n" +
    reviewResult;

  for (const chunk of splitMessage(fullText)) {
    await ctx.reply(chunk);
  }
}
