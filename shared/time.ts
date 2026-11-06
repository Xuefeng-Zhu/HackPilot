/**
 * Timezone helpers that work on both server and client with only `Intl`.
 *
 * Deadlines are stored as UTC ISO strings plus the IANA zone the organizer
 * published them in. Sprint days are calendar dates (`YYYY-MM-DD`) in the
 * planner's timezone.
 */

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** UTC ISO 8601 string (same output as `Date#toISOString()`). */
export function toUtcIso(value: Date | number = new Date()): string {
  const d = typeof value === "number" ? new Date(value) : value;
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}Z`;
}

const TZ_ALIASES: Record<string, string> = {
  PT: "America/Los_Angeles",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  MT: "America/Denver",
  MST: "America/Denver",
  MDT: "America/Denver",
  CT: "America/Chicago",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  ET: "America/New_York",
  EST: "America/New_York",
  EDT: "America/New_York",
  UTC: "UTC",
  GMT: "UTC",
  BST: "Europe/London",
  CET: "Europe/Paris",
  CEST: "Europe/Paris",
  IST: "Asia/Kolkata",
  JST: "Asia/Tokyo",
  SGT: "Asia/Singapore",
  AEST: "Australia/Sydney",
  AEDT: "Australia/Sydney",
};

export function normalizeTimezone(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "UTC";
  const alias = TZ_ALIASES[raw.toUpperCase()];
  const candidate = alias ?? raw;
  return isValidTimezone(candidate) ? candidate : "UTC";
}

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function timezoneAlias(token: string): string | null {
  return TZ_ALIASES[token.toUpperCase()] ?? null;
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(date: Date, timeZone: string): WallParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  const get = (k: string) => out[k] ?? 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === 24 ? 0 : get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `timeZone` from UTC at `date`, in minutes (PDT = -420). */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Convert a wall-clock time in `timeZone` to a UTC ISO string. */
export function zonedWallTimeToUtcIso(
  wall: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
  },
  timeZone: string,
): string {
  const tz = normalizeTimezone(timeZone);
  const guess = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour ?? 0,
    wall.minute ?? 0,
  );
  // Two passes settle DST transitions.
  let ts = guess - zoneOffsetMinutes(new Date(guess), tz) * 60000;
  ts = guess - zoneOffsetMinutes(new Date(ts), tz) * 60000;
  return toUtcIso(ts);
}

/** Calendar date (`YYYY-MM-DD`) of an instant in a timezone. */
export function dateKeyInZone(date: Date, timeZone: string): string {
  const p = partsInZone(date, normalizeTimezone(timeZone));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function addDaysToKey(key: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  return toUtcIso(Date.UTC(y, m - 1, d + days)).slice(0, 10);
}

export function daysBetweenKeys(from: string, to: string): number {
  const [y1 = 1970, m1 = 1, d1 = 1] = from.split("-").map(Number);
  const [y2 = 1970, m2 = 1, d2 = 1] = to.split("-").map(Number);
  return Math.round(
    (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000,
  );
}

export function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function formatInZone(
  iso: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  },
): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: normalizeTimezone(timeZone),
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Human countdown such as "3d 4h" or "45m"; "passed" when negative. */
export function countdownLabel(deadlineIso: string, now = new Date()): string {
  const ms = Date.parse(deadlineIso) - now.getTime();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "passed";
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export function monthFromName(name: string): number | null {
  return (
    MONTHS[name.slice(0, 4).toLowerCase().replace(/\.$/, "")] ??
    MONTHS[name.slice(0, 3).toLowerCase()] ??
    null
  );
}
