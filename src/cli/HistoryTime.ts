const HISTORY_TIME_UNITS = {
  MINUTES: "m",
  HOURS: "h",
  DAYS: "d",
} as const;

const HISTORY_TIME_UNIT_MS = {
  [HISTORY_TIME_UNITS.MINUTES]: 60_000,
  [HISTORY_TIME_UNITS.HOURS]: 3_600_000,
  [HISTORY_TIME_UNITS.DAYS]: 86_400_000,
} as const;

const ISO_HISTORY_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** Parses an ISO timestamp or a duration ago such as `7d`, `24h`, or `30m`. */
export function parseHistoryTime(
  value: string,
  now: number = Date.now(),
  bound: "start" | "end" = "start"
): number {
  const normalized = value.trim();
  const relativeMatch = /^(\d+)([dhm])$/.exec(normalized);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit =
      relativeMatch[2].toLowerCase() as keyof typeof HISTORY_TIME_UNIT_MS;
    if (Number.isSafeInteger(amount)) {
      return now - amount * HISTORY_TIME_UNIT_MS[unit];
    }
  }

  if (ISO_HISTORY_TIME_PATTERN.test(normalized)) {
    const [, yearText, monthText, dayText] =
      /^(\d{4})-(\d{2})-(\d{2})/.exec(normalized) ?? [];
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const daysInMonth =
      month === 2
        ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
          ? 29
          : 28
        : [4, 6, 9, 11].includes(month)
          ? 30
          : 31;
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
      throw new Error(
        `Invalid history time "${value}"; use an ISO-8601 timestamp or a relative value such as 7d, 24h, or 30m`
      );
    }
    const utcDateTime =
      normalized.length === 10
        ? `${normalized}T${bound === "end" ? "23:59:59.999" : "00:00:00.000"}Z`
        : normalized.includes("T") &&
            !/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
          ? `${normalized}Z`
          : normalized;
    const timestamp = Date.parse(utcDateTime);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }

  throw new Error(
    `Invalid history time "${value}"; use an ISO-8601 timestamp or a relative value such as 7d, 24h, or 30m`
  );
}
