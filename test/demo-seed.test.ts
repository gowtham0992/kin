import { describe, expect, it } from "vitest";
import { buildDemoSeed } from "../src/demo-seed.js";

describe("Kin demo seed", () => {
  it("builds deterministic tasks and the daily duty assignment", () => {
    const items = buildDemoSeed({
      circleId: "family-1",
      now: new Date("2026-09-02T12:00:00.000Z"),
    });

    expect(items).toHaveLength(12);
    expect(items.map((item) => item.SK)).toEqual([
      "MEMBER#evelyn",
      "MEMBER#maya",
      "MEMBER#theo",
      "TASK#2026-09-02T15:00:00.000Z#morning-water",
      "TASK#2026-09-02T21:00:00.000Z#afternoon-walk",
      "DUTY#2026-09-02",
      "DUTY#2026-09-03",
      "DUTY#2026-09-04",
      "DUTY#2026-09-05",
      "DUTY#2026-09-06",
      "DUTY#2026-09-07",
      "DUTY#2026-09-08",
    ]);
    expect(items[5]).toMatchObject({
      PK: "CIRCLE#family-1",
      memberName: "Theo",
      endsAt: "2026-09-03T00:00:00.000Z",
    });
  });

  it("keys the duty assignment by the family's local date", () => {
    const items = buildDemoSeed({
      circleId: "family-1",
      now: new Date("2026-09-03T04:30:00.000Z"),
      timeZone: "America/Denver",
    });

    expect(items[5]?.SK).toBe("DUTY#2026-09-02");
    expect(items[6]).toMatchObject({ SK: "DUTY#2026-09-03", memberName: "Maya" });
  });
});
