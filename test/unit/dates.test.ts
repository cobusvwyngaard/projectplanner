import { describe, expect, it } from "vitest";
import { addDays, daysBetween, dueState, isLocalDate, localToday, weekBounds } from "../../src/shared/dates";

describe("localToday", () => {
  it("uses Africa/Johannesburg (UTC+2)", () => {
    expect(localToday(new Date("2026-10-14T21:59:59Z"))).toBe("2026-10-14");
    expect(localToday(new Date("2026-10-14T22:00:00Z"))).toBe("2026-10-15");
  });
});

describe("isLocalDate and addDays", () => {
  it("accepts real dates only", () => {
    expect(isLocalDate("2028-02-29")).toBe(true);
    expect(isLocalDate("2026-02-29")).toBe(false);
    expect(isLocalDate("2026-1-1")).toBe(false);
  });

  it("adds across months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("daysBetween", () => {
  it("counts whole days either way", () => {
    expect(daysBetween("2026-10-14", "2026-10-14")).toBe(0);
    expect(daysBetween("2026-10-14", "2026-10-16")).toBe(2);
    expect(daysBetween("2026-10-14", "2026-10-01")).toBe(-13);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
  });
});

describe("dueState", () => {
  const today = "2026-10-14";

  it("is null without a due date", () => {
    expect(dueState(null, today)).toBeNull();
  });

  it("marks past dates overdue", () => {
    expect(dueState("2026-10-13", today)).toBe("overdue");
    expect(dueState("2025-12-31", today)).toBe("overdue");
  });

  it("recognises today", () => {
    expect(dueState("2026-10-14", today)).toBe("today");
  });

  it("counts the next two days as soon", () => {
    expect(dueState("2026-10-15", today)).toBe("soon");
    expect(dueState("2026-10-16", today)).toBe("soon");
    expect(dueState("2026-10-17", today)).toBe("later");
  });

  it("works across a month end", () => {
    expect(dueState("2026-11-01", "2026-10-31")).toBe("soon");
    expect(dueState("2026-10-31", "2026-11-01")).toBe("overdue");
  });
});

describe("weekBounds", () => {
  it("runs from Monday to Sunday", () => {
    // 14 October 2026 is a Wednesday.
    expect(weekBounds("2026-10-14")).toEqual({ start: "2026-10-12", end: "2026-10-18" });
  });

  it("keeps a Monday and a Sunday in their own week", () => {
    expect(weekBounds("2026-10-12")).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    expect(weekBounds("2026-10-18")).toEqual({ start: "2026-10-12", end: "2026-10-18" });
  });

  it("spans a year end", () => {
    // 1 January 2027 is a Friday.
    expect(weekBounds("2027-01-01")).toEqual({ start: "2026-12-28", end: "2027-01-03" });
  });
});
