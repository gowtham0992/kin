import { describe, expect, it } from "vitest";
import { buildDemoSeed } from "../src/demo-seed.js";

describe("Kin demo seed", () => {
  it("builds deterministic tasks and the daily duty assignment", () => {
    const items = buildDemoSeed({
      circleId: "family-1",
      now: new Date("2026-09-02T12:00:00.000Z"),
    });

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.SK)).toEqual([
      "TASK#2026-09-02T15:00:00.000Z#morning-water",
      "TASK#2026-09-02T21:00:00.000Z#afternoon-walk",
      "DUTY#2026-09-02",
    ]);
    expect(items[2]).toMatchObject({
      PK: "CIRCLE#family-1",
      memberName: "Theo",
      endsAt: "2026-09-03T02:00:00.000Z",
    });
  });
});
