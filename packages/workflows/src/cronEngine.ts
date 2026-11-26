import type { WorkflowMisfirePolicy } from "@messiah/shared";

interface ParsedCronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function parseCronField(
  field: string,
  min: number,
  max: number,
  allowSundaySeven = false
): Set<number> {
  const result = new Set<number>();
  const trimmed = field.trim();
  if (!trimmed) {
    throw new Error("Empty cron field");
  }

  for (const part of trimmed.split(",")) {
    const seg = part.trim();
    if (!seg) throw new Error(`Invalid cron list segment in '${field}'`);

    const [rangePartRaw, stepPart] = seg.split("/");
    const rangePart = (rangePartRaw ?? "").trim();
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step '${stepPart}' in '${field}'`);
    }

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [rawStart, rawEnd] = rangePart.split("-");
        start = Number(rawStart);
        end = Number(rawEnd);
      } else {
        start = Number(rangePart);
        end = Number(rangePart);
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        throw new Error(`Invalid cron range '${rangePart}' in '${field}'`);
      }
      if (start < min || end > (allowSundaySeven && max === 6 ? 7 : max)) {
        throw new Error(`Cron value out of bounds [${min}..${max}] in '${field}'`);
      }
    }

    for (let v = start; v <= end; v += step) {
      result.add(allowSundaySeven && v === 7 ? 0 : v);
    }
  }

  if (result.size === 0) {
    throw new Error(`Cron field '${field}' matched zero values`);
  }
  return result;
}

export class CronExpressionEngine {
  private static formatterCache = new Map<string, Intl.DateTimeFormat>();

  private static getFormatter(timezone: string): Intl.DateTimeFormat {
    const key = timezone || "UTC";
    let fmt = this.formatterCache.get(key);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: key,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        weekday: "short",
        hourCycle: "h23",
      });
      this.formatterCache.set(key, fmt);
    }
    return fmt;
  }

  public static validateTimezone(timezone: string): boolean {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  }

  public static parse(cronExpression: string): ParsedCronFields {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(
        `Cron expression must have exactly 5 fields (minute hour day month weekday), received ${parts.length}`
      );
    }
    const [minF = "*", hourF = "*", domF = "*", monF = "*", dowF = "*"] = parts;
    return {
      minutes: parseCronField(minF, 0, 59),
      hours: parseCronField(hourF, 0, 23),
      daysOfMonth: parseCronField(domF, 1, 31),
      months: parseCronField(monF, 1, 12),
      daysOfWeek: parseCronField(dowF, 0, 6, true),
      domWildcard: domF.trim() === "*",
      dowWildcard: dowF.trim() === "*",
    };
  }

  public static validate(
    cronExpression: string,
    timezone = "UTC"
  ): { valid: boolean; error?: string; nextRunAt?: Date | null } {
    if (!this.validateTimezone(timezone)) {
      return { valid: false, error: `Invalid IANA timezone '${timezone}'` };
    }
    try {
      const nextRunAt = this.getNextRunAt(cronExpression, timezone, new Date());
      if (!nextRunAt) {
        return { valid: false, error: "No future occurrence found within 366 days" };
      }
      return { valid: true, nextRunAt };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "Invalid cron expression",
      };
    }
  }

  private static extractZonedParts(
    date: Date,
    timezone: string
  ): { month: number; day: number; hour: number; minute: number; weekday: number } {
    const parts = this.getFormatter(timezone).formatToParts(date);
    let month = 1;
    let day = 1;
    let hour = 0;
    let minute = 0;
    let weekday = 0;

    for (const p of parts) {
      if (p.type === "month") month = Number(p.value);
      else if (p.type === "day") day = Number(p.value);
      else if (p.type === "hour") hour = Number(p.value) % 24;
      else if (p.type === "minute") minute = Number(p.value);
      else if (p.type === "weekday") weekday = WEEKDAY_MAP[p.value] ?? 0;
    }

    return { month, day, hour, minute, weekday };
  }

  private static matches(fields: ParsedCronFields, date: Date, timezone: string): boolean {
    const z = this.extractZonedParts(date, timezone);
    if (!fields.minutes.has(z.minute)) return false;
    if (!fields.hours.has(z.hour)) return false;
    if (!fields.months.has(z.month)) return false;

    const domMatch = fields.daysOfMonth.has(z.day);
    const dowMatch = fields.daysOfWeek.has(z.weekday);

    if (fields.domWildcard && fields.dowWildcard) return true;
    if (fields.domWildcard) return dowMatch;
    if (fields.dowWildcard) return domMatch;
    return domMatch || dowMatch; // Standard POSIX OR when both DOM & DOW specified
  }

  /**
   * Computes the next UTC Date matching the cron expression in the specified IANA timezone.
   */
  public static getNextRunAt(
    cronExpression: string,
    timezone = "UTC",
    afterDate: Date = new Date()
  ): Date | null {
    if (!this.validateTimezone(timezone)) {
      throw new Error(`Invalid timezone '${timezone}'`);
    }
    const parsed = this.parse(cronExpression);

    // Advance strictly to next minute boundary
    let cursorMs = Math.floor(afterDate.getTime() / 60000) * 60000 + 60000;
    const maxMinutesToScan = 366 * 24 * 60;

    for (let step = 0; step < maxMinutesToScan; step++) {
      const candidate = new Date(cursorMs);
      if (this.matches(parsed, candidate, timezone)) {
        return candidate;
      }
      cursorMs += 60000;
    }

    return null;
  }

  /**
   * Evaluates due ticks between a schedule's nextRunAt and `now`, applying misfire policy safely.
   */
  public static evaluateMisfire(params: {
    cronExpression: string;
    timezone: string;
    dueAt: Date;
    now: Date;
    misfirePolicy: WorkflowMisfirePolicy;
  }): { fireCount: number; nextRunAt: Date | null } {
    const { cronExpression, timezone, dueAt, now, misfirePolicy } = params;
    if (dueAt.getTime() > now.getTime()) {
      return { fireCount: 0, nextRunAt: dueAt };
    }

    const nextFuture = this.getNextRunAt(cronExpression, timezone, now);

    if (misfirePolicy === "SKIP") {
      // If more than 2 minutes late, skip missed tick and schedule next future run
      const latenessMs = now.getTime() - dueAt.getTime();
      return {
        fireCount: latenessMs <= 120_000 ? 1 : 0,
        nextRunAt: nextFuture,
      };
    }

    if (misfirePolicy === "FIRE_ONCE") {
      return { fireCount: 1, nextRunAt: nextFuture };
    }

    // CATCH_UP_BOUNDED: count missed occurrences up to max 5
    let count = 1;
    let cursor: Date | null = dueAt;
    while (count < 5 && cursor) {
      const nxt = this.getNextRunAt(cronExpression, timezone, cursor);
      if (!nxt || nxt.getTime() > now.getTime()) break;
      count++;
      cursor = nxt;
    }
    return { fireCount: count, nextRunAt: nextFuture };
  }
}
