import type { Context } from "grammy";
import { getLogger } from "../../logger.js";
import { createReminder } from "../../reminder/index.js";

const TZ = "America/Chicago";

/**
 * Parse a natural language time expression relative to `now`.
 *
 * Supported patterns (all case-insensitive):
 *   "in 30 minutes" / "in 2 hours" / "in 3 days" / "in 1 week"
 *   "at 5pm" / "at 17:30" / "at 9:30am"
 *   "tomorrow" (= tomorrow at 9:00 AM CT)
 *   "tomorrow morning" (9 AM) / "tomorrow afternoon" (2 PM)
 *   "tomorrow evening" / "tomorrow night" (7 PM)
 *   "tomorrow at 3pm" / "tomorrow at 14:00"
 *
 * Returns fire time as a Date, or null if not recognized.
 * The remaining string (the reminder message) is everything before the time expression.
 */
interface ParsedReminder {
  message: string;
  fireAt: Date;
}

function _nowCT(): Date {
  // Get current CT date components
  return new Date();
}

/**
 * Build a Date in CT for today at a specific hour/minute.
 * If the resulting time is in the past, rolls to tomorrow.
 */
function todayAtCT(
  hour: number,
  minute: number,
  base: Date,
  allowPast = false,
): Date {
  // Format base date as CT date parts
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(base);
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value) - 1;
  const day = Number(parts.find((p) => p.type === "day")!.value);

  // Construct as UTC by computing offset
  const candidate = new Date(
    `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
  );
  // The above is parsed as local time — adjust to CT
  // We convert via UTC: get the CT offset at this moment and apply it
  const ctOffset = getCTOffsetMinutes(candidate);
  const utcMs = candidate.getTime() - ctOffset * 60_000;
  const result = new Date(utcMs);

  if (!allowPast && result <= base) {
    // Roll to same time tomorrow
    return new Date(result.getTime() + 24 * 3600_000);
  }
  return result;
}

/**
 * Return CT offset in minutes (e.g., -360 for CST, -300 for CDT).
 */
function getCTOffsetMinutes(date: Date): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const ctStr = date.toLocaleString("en-US", { timeZone: TZ });
  const utcDate = new Date(utcStr);
  const ctDate = new Date(ctStr);
  return (ctDate.getTime() - utcDate.getTime()) / 60_000;
}

/**
 * Parse "H:MMam", "Hpm", "H:MM", etc. into { hour, minute }.
 */
function parseTimeStr(
  timeStr: string,
): { hour: number; minute: number } | null {
  const m = timeStr.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const period = m[3]?.toLowerCase();

  if (period === "pm" && hour !== 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { hour, minute };
}

export function parseReminderInput(
  input: string,
  now: Date = new Date(),
): ParsedReminder | null {
  const text = input.trim();

  // --- Pattern: "<msg> in <n> <unit>" ---
  const inMatch = text.match(
    /^(.+?)\s+in\s+(\d+)\s+(minutes?|hours?|days?|weeks?)$/i,
  );
  if (inMatch) {
    const message = inMatch[1].trim();
    const amount = parseInt(inMatch[2], 10);
    const unit = inMatch[3].toLowerCase();
    const fireAt = new Date(now);
    if (unit.startsWith("minute"))
      fireAt.setMinutes(fireAt.getMinutes() + amount);
    else if (unit.startsWith("hour"))
      fireAt.setHours(fireAt.getHours() + amount);
    else if (unit.startsWith("day")) fireAt.setDate(fireAt.getDate() + amount);
    else if (unit.startsWith("week"))
      fireAt.setDate(fireAt.getDate() + amount * 7);
    return { message, fireAt };
  }

  // --- Pattern: "<msg> tomorrow at <time>" ---
  const tomorrowAtMatch = text.match(/^(.+?)\s+tomorrow\s+at\s+([\d:apm]+)$/i);
  if (tomorrowAtMatch) {
    const message = tomorrowAtMatch[1].trim();
    const parsed = parseTimeStr(tomorrowAtMatch[2]);
    if (parsed) {
      const tomorrow = new Date(now.getTime() + 24 * 3600_000);
      const fireAt = todayAtCT(parsed.hour, parsed.minute, tomorrow, true);
      return { message, fireAt };
    }
  }

  // --- Pattern: "<msg> tomorrow morning/afternoon/evening/night" ---
  const tomorrowPeriodMatch = text.match(
    /^(.+?)\s+tomorrow\s+(morning|afternoon|evening|night)$/i,
  );
  if (tomorrowPeriodMatch) {
    const message = tomorrowPeriodMatch[1].trim();
    const period = tomorrowPeriodMatch[2].toLowerCase();
    const hourMap: Record<string, number> = {
      morning: 9,
      afternoon: 14,
      evening: 19,
      night: 21,
    };
    const tomorrow = new Date(now.getTime() + 24 * 3600_000);
    const fireAt = todayAtCT(hourMap[period], 0, tomorrow, true);
    return { message, fireAt };
  }

  // --- Pattern: "<msg> tomorrow" (= tomorrow 9am) ---
  const tomorrowMatch = text.match(/^(.+?)\s+tomorrow$/i);
  if (tomorrowMatch) {
    const message = tomorrowMatch[1].trim();
    const tomorrow = new Date(now.getTime() + 24 * 3600_000);
    const fireAt = todayAtCT(9, 0, tomorrow, true);
    return { message, fireAt };
  }

  // --- Pattern: "<msg> at <time>" (today or next occurrence) ---
  const atMatch = text.match(/^(.+?)\s+at\s+([\d:apm]+)$/i);
  if (atMatch) {
    const message = atMatch[1].trim();
    const parsed = parseTimeStr(atMatch[2]);
    if (parsed) {
      const fireAt = todayAtCT(parsed.hour, parsed.minute, now);
      return { message, fireAt };
    }
  }

  return null;
}

function formatFireTime(fireAt: Date): string {
  return fireAt.toLocaleString("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export async function remindHandler(ctx: Context): Promise<void> {
  const logger = getLogger();
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!userId || !chatId) return;

  const input = (
    typeof ctx.match === "string" ? ctx.match : (ctx.match?.[0] ?? "")
  ).trim();

  if (!input) {
    await ctx.reply(
      "Usage: /remind <message> <time>\n\n" +
        "Examples:\n" +
        "  /remind take out trash in 30 minutes\n" +
        "  /remind call dentist tomorrow at 3pm\n" +
        "  /remind check backups at 9am\n" +
        "  /remind standup tomorrow morning\n" +
        "  /remind review PR in 2 hours",
    );
    return;
  }

  const parsed = parseReminderInput(input);
  if (!parsed) {
    await ctx.reply(
      "Couldn't parse the time from that. Try:\n" +
        "  /remind <message> in <n> minutes/hours/days\n" +
        "  /remind <message> at <time>\n" +
        "  /remind <message> tomorrow [at <time>|morning|afternoon|evening]",
    );
    return;
  }

  try {
    const id = createReminder(userId, chatId, parsed.message, parsed.fireAt);
    const formatted = formatFireTime(parsed.fireAt);
    await ctx.reply(`Reminder set for ${formatted} CT\n"${parsed.message}"`);
    logger.info(
      { id, message: parsed.message, fireAt: parsed.fireAt.toISOString() },
      "Reminder created",
    );
  } catch (err) {
    logger.error({ error: err }, "Failed to create reminder");
    await ctx.reply("Failed to save reminder.");
  }
}
