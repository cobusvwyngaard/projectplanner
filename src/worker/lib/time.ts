// Time helpers. Stored timestamps are UTC ISO strings; due dates are local
// dates in Africa/Johannesburg (UTC+2, no daylight saving).

export const TIME_ZONE = "Africa/Johannesburg";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function iso(date: Date): string {
  return date.toISOString();
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

/** Today's date (YYYY-MM-DD) in Africa/Johannesburg. */
export function localToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in YYYY-MM-DD form. */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}
