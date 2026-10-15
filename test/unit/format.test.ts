import { describe, expect, it } from "vitest";
import {
  describeUserAgent,
  excerpt,
  formatDate,
  formatDateTime,
  formatDue,
  relativeTime,
} from "../../src/shared/format";

describe("formatDate", () => {
  it("writes day, short month and year", () => {
    expect(formatDate("2026-10-14")).toBe("14 Oct 2026");
    expect(formatDate("2027-01-01")).toBe("1 Jan 2027");
    expect(formatDate("2026-09-30")).toBe("30 Sep 2026");
  });

  it("leaves anything that is not a date alone", () => {
    expect(formatDate("soon")).toBe("soon");
  });
});

describe("formatDateTime", () => {
  it("shows the time in Africa/Johannesburg", () => {
    expect(formatDateTime("2026-10-14T06:30:00.000Z")).toBe("14 Oct 2026, 08:30");
    expect(formatDateTime("2026-10-14T22:05:00.000Z")).toBe("15 Oct 2026, 00:05");
    expect(formatDateTime("2026-12-31T21:59:00Z")).toBe("31 Dec 2026, 23:59");
  });

  it("leaves an unreadable timestamp alone", () => {
    expect(formatDateTime("nonsense")).toBe("nonsense");
  });
});

describe("relativeTime", () => {
  // 14 Oct 2026, 10:00 in Johannesburg.
  const now = new Date("2026-10-14T08:00:00.000Z");

  it("says just now within a minute (and for clock skew)", () => {
    expect(relativeTime("2026-10-14T07:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("2026-10-14T08:00:20.000Z", now)).toBe("just now");
  });

  it("counts minutes within the hour", () => {
    expect(relativeTime("2026-10-14T07:55:00.000Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-10-14T07:00:01.000Z", now)).toBe("59 min ago");
  });

  it("counts hours earlier the same day", () => {
    expect(relativeTime("2026-10-14T06:00:00.000Z", now)).toBe("2 h ago");
    // 00:30 local is still today.
    expect(relativeTime("2026-10-13T22:30:00.000Z", now)).toBe("9 h ago");
  });

  it("says yesterday for the previous local day", () => {
    // 23:30 local on 13 Oct.
    expect(relativeTime("2026-10-13T21:30:00.000Z", now)).toBe("yesterday");
    expect(relativeTime("2026-10-12T22:00:00.000Z", now)).toBe("yesterday");
  });

  it("gives the date for anything older", () => {
    expect(relativeTime("2026-10-12T21:59:00.000Z", now)).toBe("12 Oct 2026");
    expect(relativeTime("2025-01-05T10:00:00.000Z", now)).toBe("5 Jan 2025");
  });
});

describe("formatDue", () => {
  const today = "2026-10-14";

  it("uses words for the days around today", () => {
    expect(formatDue("2026-10-14", today)).toBe("Today");
    expect(formatDue("2026-10-15", today)).toBe("Tomorrow");
    expect(formatDue("2026-10-13", today)).toBe("Yesterday");
  });

  it("leaves out the year when it is this year", () => {
    expect(formatDue("2026-11-02", today)).toBe("2 Nov");
    expect(formatDue("2027-01-02", today)).toBe("2 Jan 2027");
    expect(formatDue("2025-12-30", today)).toBe("30 Dec 2025");
  });
});

describe("excerpt", () => {
  it("squeezes whitespace and cuts long text with an ellipsis", () => {
    expect(excerpt("  one\n two   three ", 50)).toBe("one two three");
    expect(excerpt("abcdefghij", 5)).toBe("abcd…");
    expect(excerpt("abcde", 5)).toBe("abcde");
  });
});

describe("describeUserAgent", () => {
  it("names common browsers and systems", () => {
    const cases: [string, string][] = [
      [
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
        "Chrome on Android",
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        "Safari on iPhone",
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
        "Home-screen app on iPhone",
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1",
        "Chrome on iPhone",
      ],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
        "Safari on Mac",
      ],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
        "Edge on Windows",
      ],
      ["Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox on Linux"],
      [
        "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
        "Samsung Internet on Android",
      ],
    ];
    for (const [ua, expected] of cases) expect(describeUserAgent(ua)).toBe(expected);
  });

  it("falls back gracefully", () => {
    expect(describeUserAgent(null)).toBe("Unknown browser");
    expect(describeUserAgent("  ")).toBe("Unknown browser");
    expect(describeUserAgent("curl/8.5.0")).toBe("Unknown browser");
    expect(describeUserAgent("SomeBot (Windows NT 10.0)")).toBe("Browser on Windows");
  });
});
