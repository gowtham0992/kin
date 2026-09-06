import { describe, expect, it } from "vitest";
import { InMemoryCareStore, TaskNotFoundError, createDemoStore } from "../src/domain.js";
import { DutyConflict } from "../src/duty-change.js";

const fixedNow = () => new Date("2026-09-02T08:00:00.000Z");

describe("Kin care loop", () => {
  it("shows today's tasks in due-time order", async () => {
    const snapshot = await createDemoStore(fixedNow).today();
    expect(snapshot.tasks.map((task) => task.id)).toEqual([
      "morning-water",
      "afternoon-walk",
    ]);
    expect(snapshot.summary).toEqual({ total: 2, completed: 0, remaining: 2, skipped: 0 });
  });

  it("shows the complete seven-day sibling rotation in the demo", async () => {
    const circle = await createDemoStore(fixedNow).circle();

    expect(circle.assignments).toHaveLength(7);
    expect(circle.assignments.map(({ memberName }) => memberName)).toEqual([
      "Theo",
      "Maya",
      "Theo",
      "Maya",
      "Theo",
      "Maya",
      "Theo",
    ]);
  });

  it("records a completed task and updates shared state", async () => {
    const store = createDemoStore(fixedNow);
    const result = await store.confirm({
      taskId: "morning-water",
      response: "done",
      actor: "Mom",
      requestId: "request-0001",
    });

    expect(result.replayed).toBe(false);
    expect(result.task.state).toBe("done");
    expect((await store.today()).summary).toEqual({ total: 2, completed: 1, remaining: 1, skipped: 0 });
  });

  it("makes confirmation retries idempotent", async () => {
    const store = createDemoStore(fixedNow);
    const input = {
      taskId: "morning-water",
      response: "done" as const,
      actor: "Mom",
      requestId: "request-0002",
    };

    const first = await store.confirm(input);
    const second = await store.confirm(input);
    expect(second.replayed).toBe(true);
    expect(second.confirmation.id).toBe(first.confirmation.id);
  });

  it("rejects an unknown task", async () => {
    const store = createDemoStore(fixedNow);
    await expect(
      store.confirm({
        taskId: "not-a-real-task",
        response: "done",
        actor: "Mom",
        requestId: "request-0003",
      }),
    ).rejects.toThrow(TaskNotFoundError);
  });

  it("adds reviewed coverage to an uncovered day and retains server attribution", async () => {
    const store = new InMemoryCareStore([], fixedNow);
    const input = { date: "2026-09-02", memberId: "maya", expectedMemberId: null, requestId: "handoff-0001", actor: "Gowtham" };
    const result = await store.assignDuty(input);
    expect(result).toMatchObject({ requestId: input.requestId, assignments: [{
      date: input.date, memberId: "maya", memberName: "Maya", startsAt: "2026-09-02T00:00:00.000Z",
      endsAt: "2026-09-03T00:00:00.000Z", changedBy: "Gowtham", changedAt: fixedNow().toISOString(),
    }] });
    result.assignments[0]!.memberName = "Changed outside the repository";
    expect((await store.assignDuty(input)).assignments[0]!.memberName).toBe("Maya");
  });

  it("permits only one of two handoffs reviewed against the same original caregiver", async () => {
    const store = createDemoStore(fixedNow);
    const outcomes = await Promise.allSettled([
      store.assignDuty({ date: "2026-09-02", memberId: "maya", expectedMemberId: "theo", requestId: "handoff-first" }),
      store.assignDuty({ date: "2026-09-02", memberId: "theo", expectedMemberId: "theo", requestId: "handoff-second" }),
    ]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "rejected"]);
    expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(DutyConflict);
    expect((await store.circle()).assignments[0]!.memberId).toBe("maya");
  });

  it("replays a handoff after another handoff and after its roster week has expired", async () => {
    let clock = fixedNow();
    const store = createDemoStore(() => clock);
    const first = { date: "2026-09-02", memberId: "maya", expectedMemberId: "theo", requestId: "handoff-original" };
    const receipt = await store.assignDuty(first);
    await store.assignDuty({ date: first.date, memberId: "theo", expectedMemberId: "maya", requestId: "handoff-next" });
    expect(await store.assignDuty(first)).toEqual(receipt);
    expect((await store.circle()).assignments[0]!.memberId).toBe("theo");
    clock = new Date("2026-09-10T08:00:00.000Z");
    expect(await store.assignDuty(first)).toEqual(receipt);
    await expect(store.assignDuty({ ...first, requestId: "handoff-expired" })).rejects.toThrow("visible roster week");
  });

  it("does not reuse a successful request for different reviewed input", async () => {
    const store = createDemoStore(fixedNow);
    const input = { date: "2026-09-02", memberId: "maya", expectedMemberId: "theo", requestId: "handoff-bound", actor: "Maya" };
    await store.assignDuty(input);
    for (const change of [{ date: "2026-09-03" }, { memberId: "theo" }, { expectedMemberId: "maya" }, { actor: "Theo" }]) {
      await expect(store.assignDuty({ ...input, ...change })).rejects.toThrow(DutyConflict);
    }
  });

  it("rejects partial reviewed requests, ineligible recipients and dates outside the week", async () => {
    const store = createDemoStore(fixedNow);
    const base = { date: "2026-09-02", memberId: "maya" };
    for (const invalid of [{ ...base, requestId: "handoff-partial" }, { ...base, expectedMemberId: "theo" }]) {
      await expect(store.assignDuty(invalid)).rejects.toThrow("Invalid duty assignment");
    }
    await expect(store.assignDuty({ ...base, memberId: "evelyn" })).rejects.toThrow("eligible for duty");
    for (const date of ["2026-09-01", "2026-09-09"]) {
      await expect(store.assignDuty({ ...base, date })).rejects.toThrow("visible roster week");
    }
    const legacy = await store.assignDuty(base);
    expect(legacy).not.toHaveProperty("requestId");
    expect(legacy.assignments[0]).not.toHaveProperty("changedAt");
  });
});
