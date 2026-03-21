import type { Context } from "grammy";
import { getConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { createReminder } from "../../reminder/index.js";

interface ParsedReminder {
  message: string;
  fireAt: Date;
  recurMs?: number;
}

/**
 * Build a Date in the configured timezone for a specific hour/minute.
 * If the resulting time is in the past, rolls to tomorrow (unless allowPast=true).
 */
function todayAtTZ(
  hour: number,
  minute: number,
  base: Date,
  tz: string,
  allowPast = false,
): Date {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(base);
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value) - 1;
  const day = Number(parts.find((p) => p.type === "day")!.value);

  const candidate = new Date(
    `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
  );
  const offset = getTZOffsetMinutes(candidate, tz);
  const result = new Date(candidate.getTime() - offset * 60_000);

  if (!allowPast && result <= base) {
    return new Date(result.getTime() + 24 * 3600_000);
  }
  return result;
}

function getTZOffsetMinutes(date: Date, tz: string): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = date.toLocaleString("en-US", { timeZone: tz });
  return (new Date(tzStr).getTime() - new Date(utcStr).getTime()) / 60_000;
}

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
  tz = "America/Chicago",
): ParsedReminder | null {
  const text = input.trim();

  // --- Recurring: "<msg> every day [at <time>]" ---
  const everyDayAtMatch = text.match(
    /^(.+?)\s+every\s+day\s+at\s+([\d:apm]+)$/i,
  );
  if (everyDayAtMatch) {
    const message = everyDayAtMatch[1].trim();
    const parsed = parseTimeStr(everyDayAtMatch[2]);
    if (parsed) {
      const fireAt = todayAtTZ(parsed.hour, parsed.minute, now, tz);
      return { message, fireAt, recurMs: 24 * 3600_000 };
    }
  }

  // --- Recurring: "<msg> every day" (9am default) ---
  const everyDayMatch = text.match(/^(.+?)\s+every\s+day$/i);
  if (everyDayMatch) {
    const message = everyDayMatch[1].trim();
    const fireAt = todayAtTZ(9, 0, now, tz);
    return { message, fireAt, recurMs: 24 * 3600_000 };
  }

  // --- Recurring: "<msg> every week [at <time>]" ---
  const everyWeekAtMatch = text.match(
    /^(.+?)\s+every\s+week\s+at\s+([\d:apm]+)$/i,
  );
  if (everyWeekAtMatch) {
    const message = everyWeekAtMatch[1].trim();
    const parsed = parseTimeStr(everyWeekAtMatch[2]);
    if (parsed) {
      const fireAt = todayAtTZ(parsed.hour, parsed.minute, now, tz);
      return { message, fireAt, recurMs: 7 * 24 * 3600_000 };
    }
  }

  // --- Recurring: "<msg> every week" ---
  const everyWeekMatch = text.match(/^(.+?)\s+every\s+week$/i);
  if (everyWeekMatch) {
    const message = everyWeekMatch[1].trim();
    const fireAt = new Date(now.getTime() + 7 * 24 * 3600_000);
    return { message, fireAt, recurMs: 7 * 24 * 3600_000 };
  }

  // --- Recurring: "<msg> every <n> minutes/hours/days" ---
  const everyIntervalMatch = text.match(
    /^(.+?)\s+every\s+(\d+)\s+(minutes?|hours?|days?)$/i,
  );
  if (everyIntervalMatch) {
    const message = everyIntervalMatch[1].trim();
    const amount = parseInt(everyIntervalMatch[2], 10);
    const unit = everyIntervalMatch[3].toLowerCase();
    let recurMs = 0;
    if (unit.startsWith("minute")) recurMs = amount * 60_000;
    else if (unit.startsWith("hour")) recurMs = amount * 3600_000;
    else if (unit.startsWith("day")) recurMs = amount * 24 * 3600_000;
    if (recurMs > 0) {
      const fireAt = new Date(now.getTime() + recurMs);
      return { message, fireAt, recurMs };
    }
  }

  // --- One-time: "<msg> in <n> <unit>" ---
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

  // --- One-time: "<msg> tomorrow at <time>" ---
  const tomorrowAtMatch = text.match(/^(.+?)\s+tomorrow\s+at\s+([\d:apm]+)$/i);
  if (tomorrowAtMatch) {
    const message = tomorrowAtMatch[1].trim();
    const parsed = parseTimeStr(tomorrowAtMatch[2]);
    if (parsed) {
      const tomorrow = new Date(now.getTime() + 24 * 3600_000);
      const fireAt = todayAtTZ(parsed.hour, parsed.minute, tomorrow, tz, true);
      return { message, fireAt };
    }
  }

  // --- One-time: "<msg> tomorrow morning/afternoon/evening/night" ---
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
    const fireAt = todayAtTZ(hourMap[period], 0, tomorrow, tz, true);
    return { message, fireAt };
  }

  // --- One-time: "<msg> tomorrow" (= tomorrow 9am) ---
  const tomorrowMatch = text.match(/^(.+?)\s+tomorrow$/i);
  if (tomorrowMatch) {
    const message = tomorrowMatch[1].trim();
    const tomorrow = new Date(now.getTime() + 24 * 3600_000);
    const fireAt = todayAtTZ(9, 0, tomorrow, tz, true);
    return { message, fireAt };
  }

  // --- One-time: "<msg> at <time>" ---
  const atMatch = text.match(/^(.+?)\s+at\s+([\d:apm]+)$/i);
  if (atMatch) {
    const message = atMatch[1].trim();
    const parsed = parseTimeStr(atMatch[2]);
    if (parsed) {
      const fireAt = todayAtTZ(parsed.hour, parsed.minute, now, tz);
      return { message, fireAt };
    }
  }

  return null;
}

function formatFireTime(fireAt: Date, tz: string): string {
  return fireAt.toLocaleString("en-US", {
    timeZone: tz,
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
  const config = getConfig();
  const tz = config.timezone;
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
        "  /remind standup every day at 9am\n" +
        "  /remind review metrics every week\n" +
        "  /remind review PR in 2 hours",
    );
    return;
  }

  const parsed = parseReminderInput(input, new Date(), tz);
  if (!parsed) {
    await ctx.reply(
      "Couldn't parse the time from that. Try:\n" +
        "  /remind <message> in <n> minutes/hours/days\n" +
        "  /remind <message> at <time>\n" +
        "  /remind <message> tomorrow [at <time>|morning|afternoon|evening]\n" +
        "  /remind <message> every day [at <time>]\n" +
        "  /remind <message> every week",
    );
    return;
  }

  try {
    const id = createReminder(
      userId,
      chatId,
      parsed.message,
      parsed.fireAt,
      parsed.recurMs,
    );
    const formatted = formatFireTime(parsed.fireAt, tz);
    const recurSuffix = parsed.recurMs
      ? ` (repeats every ${formatRecurInterval(parsed.recurMs)})`
      : "";
    await ctx.reply(
      `Reminder set for ${formatted}${recurSuffix}\n"${parsed.message}"`,
    );
    logger.info(
      {
        id,
        message: parsed.message,
        fireAt: parsed.fireAt.toISOString(),
        recurMs: parsed.recurMs,
      },
      "Reminder created",
    );
  } catch (err) {
    logger.error({ error: err }, "Failed to create reminder");
    await ctx.reply("Failed to save reminder.");
  }
}

function formatRecurInterval(ms: number): string {
  if (ms === 24 * 3600_000) return "day";
  if (ms === 7 * 24 * 3600_000) return "week";
  const hours = ms / 3600_000;
  if (Number.isInteger(hours)) return `${hours} hour${hours !== 1 ? "s" : ""}`;
  const minutes = ms / 60_000;
  return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
}
