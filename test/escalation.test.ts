import { describe, expect, it } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { planMissedTaskEscalations } from "../src/escalation.js";

describe("missed-task escalation planning", () => {
  it("routes an overdue task to the active on-duty caregiver after the grace period", async () => {
    const now = new Date("2026-09-02T16:00:00.000Z");
    const snapshot = await createDemoStore(() => now).today();

    const plan = planMissedTaskEscalations({ snapshot, now, graceMinutes: 30 });

    expect(plan.blocked).toEqual([]);
    expect(plan.events).toEqual([
      expect.objectContaining({
        taskId: "morning-water",
        recipient: expect.objectContaining({ memberId: "theo" }),
      }),
    ]);
  });

  it("does not escalate a completed task", async () => {
    const now = new Date("2026-09-02T16:00:00.000Z");
    const store = createDemoStore(() => now);
    await store.confirm({
      taskId: "morning-water",
      response: "done",
      actor: "Evelyn",
      requestId: "voice-turn-0009",
    });

    const plan = planMissedTaskEscalations({ snapshot: await store.today(), now });
    expect(plan.events).toEqual([]);
  });

  it("surfaces a blocked escalation when nobody is actively on duty", async () => {
    const now = new Date("2026-09-03T03:00:00.000Z");
    const snapshot = await createDemoStore(() => new Date("2026-09-02T16:00:00.000Z")).today();

    const plan = planMissedTaskEscalations({ snapshot, now });

    expect(plan.events).toEqual([]);
    expect(plan.blocked.map((item) => item.reason)).toEqual([
      "no_active_duty_assignment",
      "no_active_duty_assignment",
    ]);
  });
});
