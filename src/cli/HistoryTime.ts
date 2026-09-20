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

/** Parses an ISO timestamp or a duration ago such as `7d`, `24h`, or `30m`. */
export function parseHistoryTime(
  value: string,
  now: number = Date.now()
): number {
  const normalized = value.trim();
  const relativeMatch = /^(\d+)([dhm])$/i.exec(normalized);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit =
      relativeMatch[2].toLowerCase() as keyof typeof HISTORY_TIME_UNIT_MS;
    if (Number.isSafeInteger(amount)) {
      return now - amount * HISTORY_TIME_UNIT_MS[unit];
    }
  }

  const timestamp = Date.parse(normalized);
  if (Number.isFinite(timestamp)) {
    return timestamp;
  }

  throw new Error(
    `Invalid history time "${value}"; use an ISO-8601 timestamp or a relative value such as 7d, 24h, or 30m`
  );
}
