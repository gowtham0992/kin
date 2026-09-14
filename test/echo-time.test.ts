import { describe, expect, it } from "vitest";
import { createEchoTimeFormatter } from "../src/echo-time.js";

describe("spoken check-in times", () => {
  const format = createEchoTimeFormatter("America/Denver");
  it("speaks a local clock time instead of hundreds of minutes", () => {
    expect(format("2026-09-14T04:30:00Z", Date.parse("2026-09-13T17:53:00Z")))
      .toBe("today at 10:30 PM MDT");
  });
  it("uses the circle's date rather than the UTC date", () => {
    expect(format("2026-09-14T14:00:00Z", Date.parse("2026-09-14T05:30:00Z")))
      .toBe("tomorrow at 8:00 AM MDT");
  });
  it("handles a 23-hour spring day by calendar date", () => {
    expect(format("2026-03-09T06:30:00Z", Date.parse("2026-03-08T07:30:00Z")))
      .toBe("tomorrow at 12:30 AM MDT");
  });
  it("distinguishes the repeated fall-back hour", () => {
    const now = Date.parse("2026-11-01T06:00:00Z");
    expect(format("2026-11-01T07:30:00Z", now)).toBe("today at 1:30 AM MDT");
    expect(format("2026-11-01T08:30:00Z", now)).toBe("today at 1:30 AM MST");
  });
  it("labels dates further ahead explicitly", () => {
    expect(format("2026-09-16T14:00:00Z", Date.parse("2026-09-13T17:00:00Z")))
      .toBe("Wednesday, September 16 at 8:00 AM MDT");
  });
  it("uses explicit UTC if a deployment has no configured circle zone", () => {
    expect(createEchoTimeFormatter()("2026-09-13T18:00:00Z", Date.parse("2026-09-13T17:00:00Z")))
      .toBe("today at 6:00 PM UTC");
  });
  it("rejects invalid configuration and invalid dates", () => {
    expect(() => createEchoTimeFormatter("not/a-zone")).toThrow();
    expect(() => format("not-a-date", 0)).toThrow();
    expect(() => format("2026-09-13T18:00:00Z", NaN)).toThrow();
  });
});
