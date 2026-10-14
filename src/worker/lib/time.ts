// Time helpers for the Worker. Date-only helpers live in src/shared/dates.ts
// because the browser needs them too.

export { TIME_ZONE, addDays, isLocalDate, localToday } from "../../shared/dates";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function iso(date: Date): string {
  return date.toISOString();
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
