// Dates, times and devices as people read them: "14 Oct 2026",
// "14 Oct 2026, 08:30" (Africa/Johannesburg), "5 min ago", "Chrome on Android".

import { TIME_ZONE, addDays, isLocalDate, localToday } from "./dates";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** "2026-10-14" → "14 Oct 2026". Anything else is returned unchanged. */
export function formatDate(date: string): string {
  if (!isLocalDate(date)) return date;
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

const LOCAL_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The local date and HH:MM of a timestamp in Africa/Johannesburg, or null if it is not a time. */
function localParts(timestamp: string): { date: string; time: string } | null {
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) return null;
  const parts: Record<string, string> = {};
  for (const part of LOCAL_PARTS.formatToParts(instant)) parts[part.type] = part.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** "2026-10-14T06:30:00Z" → "14 Oct 2026, 08:30" in Africa/Johannesburg. */
export function formatDateTime(timestamp: string): string {
  const local = localParts(timestamp);
  return local ? `${formatDate(local.date)}, ${local.time}` : timestamp;
}

/**
 * How long ago, for activity rows: "just now", "5 min ago", "2 h ago" (same
 * day), "yesterday", then the date. Times in the future count as just now.
 */
export function relativeTime(timestamp: string, now: Date = new Date()): string {
  const local = localParts(timestamp);
  if (!local) return timestamp;
  const elapsed = now.getTime() - new Date(timestamp).getTime();
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  const today = localToday(now);
  if (local.date === today) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  if (local.date === addDays(today, -1)) return "yesterday";
  return formatDate(local.date);
}

/** A due date for a chip: "Today", "Tomorrow", "Yesterday", "14 Oct" or "14 Oct 2027". */
export function formatDue(due: string, today: string): string {
  if (!isLocalDate(due)) return due;
  if (due === today) return "Today";
  if (due === addDays(today, 1)) return "Tomorrow";
  if (due === addDays(today, -1)) return "Yesterday";
  const full = formatDate(due);
  return due.slice(0, 4) === today.slice(0, 4) ? full.slice(0, -5) : full;
}

/** Text squeezed onto one line and cut to `max` characters with an ellipsis. */
export function excerpt(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

function browserName(ua: string): string | null {
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return "Edge";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "Opera";
  if (/\bSamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return "Firefox";
  if (/\b(?:Headless)?Chrome\/|\bCriOS\/|\bChromium\//.test(ua)) return "Chrome";
  if (/\bSafari\//.test(ua)) return "Safari";
  return null;
}

function systemName(ua: string): string | null {
  if (/\biPhone\b/.test(ua)) return "iPhone";
  if (/\biPad\b/.test(ua)) return "iPad";
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\bWindows\b/.test(ua)) return "Windows";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  if (/\bMacintosh\b|\bMac OS X\b/.test(ua)) return "Mac";
  if (/\bLinux\b/.test(ua)) return "Linux";
  return null;
}

/**
 * A short, friendly description of a browser from its user agent, for
 * Settings › Signed-in browsers: "Chrome on Android", "Safari on iPhone".
 * An iPhone or iPad web view without a browser name is the home-screen app.
 */
export function describeUserAgent(userAgent: string | null): string {
  const ua = userAgent?.trim() ?? "";
  if (ua === "") return "Unknown browser";
  const system = systemName(ua);
  const browser = browserName(ua) ?? ((system === "iPhone" || system === "iPad") && /AppleWebKit/.test(ua) ? "Home-screen app" : null);
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? (system ? `Browser on ${system}` : "Unknown browser");
}
