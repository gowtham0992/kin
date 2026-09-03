import { describe, expect, it } from "vitest";
import {
  calendarDate,
  calendarDayBounds,
  shiftCalendarDate,
  validateTimeZone,
} from "../src/calendar.js";

describe("care-circle calendar", () => {
  it("keeps the family on its local date after UTC midnight", () => {
    const instant = new Date("2026-09-03T04:30:00.000Z");

    expect(calendarDate(instant, "UTC")).toBe("2026-09-03");
    expect(calendarDate(instant, "America/Denver")).toBe("2026-09-02");
  });

  it("rejects an invalid configured time zone", () => {
    expect(() => validateTimeZone("Mountain-ish")).toThrow(
      "KIN_TIME_ZONE must be a valid IANA time zone",
    );
  });

  it("moves date-only calendar values across month boundaries", () => {
    expect(shiftCalendarDate("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftCalendarDate("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("rejects normalized and fractional date shifts", () => {
    expect(() => shiftCalendarDate("2026-02-31", 1)).toThrow();
    expect(() => shiftCalendarDate("2026-09-02", 0.5)).toThrow();
  });

  it("resolves local roster days across daylight-saving changes", () => {
    expect(calendarDayBounds("2026-07-10", "America/Denver")).toEqual({
      startsAt: "2026-07-10T06:00:00.000Z",
      endsAt: "2026-07-11T06:00:00.000Z",
    });
    expect(calendarDayBounds("2026-11-01", "America/Denver")).toEqual({
      startsAt: "2026-11-01T06:00:00.000Z",
      endsAt: "2026-11-02T07:00:00.000Z",
    });
  });
});
