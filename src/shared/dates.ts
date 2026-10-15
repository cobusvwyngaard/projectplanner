// Dates for people in Africa/Johannesburg (UTC+2, no daylight saving).
// Stored timestamps are UTC ISO strings; due dates are local YYYY-MM-DD.

export const TIME_ZONE = "Africa/Johannesburg";

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

/** Add whole days to a local date. */
export function addDays(date: string, days: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error("Not a YYYY-MM-DD date");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

function utcDay(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error("Not a YYYY-MM-DD date");
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / 86_400_000);
}

/** How a due date relates to today: past, today, within two days, or later. */
export type DueState = "overdue" | "today" | "soon" | "later";

/** Days after today that still count as due soon. */
export const DUE_SOON_DAYS = 2;

/** null when there is no due date. */
export function dueState(due: string | null, today: string): DueState | null {
  if (due === null) return null;
  if (due < today) return "overdue";
  if (due === today) return "today";
  return due <= addDays(today, DUE_SOON_DAYS) ? "soon" : "later";
}

/** The week, Monday to Sunday, that contains `today`. */
export function weekBounds(today: string): { start: string; end: string } {
  // getUTCDay counts from Sunday (0); the days since Monday are (day + 6) % 7.
  const sinceMonday = (new Date(utcDay(today)).getUTCDay() + 6) % 7;
  const start = addDays(today, -sinceMonday);
  return { start, end: addDays(start, 6) };
}
