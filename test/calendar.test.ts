import { describe, expect, it } from "vitest";
import { calendarDate, validateTimeZone } from "../src/calendar.js";

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
});
