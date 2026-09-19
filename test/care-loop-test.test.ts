import { describe, expect, it, vi } from "vitest";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { careLoopTestTitle, createCareLoopTest } from "../src/care-loop-test.js";
import type { PushDestination } from "../src/web-push.js";

function fixture() {
  const clock = { value: new Date("2026-09-15T18:00:00.000Z") };
  const task: CareTask = { id: "acceptance-test", title: careLoopTestTitle,
    dueAt: "2026-09-15T17:30:00.000Z", state: "scheduled", lastResponse: null,
    confirmedBy: null, confirmedAt: null };
  const store = new InMemoryCareStore([task, { ...task, id: "unrelated", title: "Not the test" }],
    () => clock.value, { memberId: "maya", memberName: "Maya",
      startsAt: "2026-09-15T00:00:00.000Z", endsAt: "2026-09-16T00:00:00.000Z" });
  const approval = { id: "2beae637-685c-4e07-93bd-cfdd66daafbc", memberId: "maya",
    taskId: task.id, dueAt: task.dueAt, subscriptionId: "a".repeat(64),
    expiresAt: "2026-09-15T18:10:00.000Z" };
  // Transport is the only simulated boundary; care state and outbox are real in-memory domain code.
  const target = vi.fn(async () => ({ id: approval.subscriptionId } as PushDestination));
  let claimed = false;
  const claim = vi.fn(async () => { if (claimed) return false; claimed = true; return true; });
  const publish = vi.fn(async () => ({ messageId: "accepted-by-test-provider" }));
  const snapshot = vi.fn(() => store.today());
  const input = { approval, store, snapshot, target, claim, publish, now: () => clock.value };
  const request = { source: "kin.care-loop-test", approvalId: approval.id, action: "send", consent: true };
  return { ...input, clock, request, run: createCareLoopTest(input) };
}

describe("bounded care-loop acceptance", () => {
  it("creates only the selected follow-up; acknowledgment does not complete either task", async () => {
    const f = fixture();
    const result = await f.run(f.request);
    expect(result).toMatchObject({ status: "provider_accepted", delivered: false });
    const before = await f.store.today();
    expect(before.escalations.map(record => record.taskId)).toEqual(["acceptance-test"]);
    await f.store.acknowledgeEscalation({ id: before.escalations[0]!.id, memberId: "maya", name: "Maya" });
    const after = await f.store.today();
    expect(after.escalations[0]).toMatchObject({ status: "sent", acknowledgedBy: "Maya" });
    expect(after.tasks.map(task => task.state)).toEqual(["scheduled", "scheduled"]);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it("inspection leaves both approval and outbox untouched", async () => {
    const f = fixture();
    expect(await f.run({ ...f.request, action: "inspect" })).toEqual({ status: "ready", delivered: false });
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect((await f.store.today()).escalations).toEqual([]);
  });
  it.each(["task", "title", "due", "duty", "subscription", "early", "expired", "long-expiry", "completed", "prior-record"])(
    "fails closed before any write when %s differs", async condition => {
      const f = fixture();
      const snapshot = await f.store.today();
      if (condition === "task") snapshot.tasks = snapshot.tasks.filter(task => task.id !== "acceptance-test");
      if (condition === "title") snapshot.tasks[0]!.title = "Real task";
      if (condition === "due") snapshot.tasks[0]!.dueAt = "2026-09-15T17:20:00.000Z";
      if (condition === "duty") snapshot.onDuty!.memberId = "theo";
      if (condition === "subscription") f.target.mockResolvedValue({ id: "b".repeat(64) } as PushDestination);
      if (condition === "early") f.clock.value = new Date("2026-09-15T17:59:59.999Z");
      if (condition === "expired") f.clock.value = new Date(f.approval.expiresAt);
      if (condition === "long-expiry") f.clock.value = new Date("2026-09-15T17:54:59.999Z");
      if (condition === "completed") snapshot.tasks[0]!.state = "done";
      if (condition === "prior-record") snapshot.escalations = [{ id: "old", taskId: "acceptance-test",
        dueAt: f.approval.dueAt, updatedAt: f.clock.value.toISOString(), recipientMemberName: "Maya", status: "failed" }];
      f.snapshot.mockResolvedValue(snapshot);
      expect(await f.run(f.request)).toEqual({ status: "not_ready", delivered: false });
      expect(f.claim).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
      expect((await f.store.today()).escalations).toEqual([]);
    });
  it("rejects altered approval IDs and unknown invocation fields", async () => {
    const f = fixture();
    for (const request of [{ ...f.request, approvalId: "00000000-0000-4000-8000-000000000000" },
      { ...f.request, taskId: "unrelated" }, { ...f.request, consent: false }]) {
      await expect(f.run(request)).rejects.toThrow("Invalid care-loop test request");
    }
    expect(f.claim).not.toHaveBeenCalled();
  });
  it("concurrent attempts consume one permanent approval", async () => {
    const f = fixture();
    await Promise.all([f.run(f.request), f.run(f.request)]);
    await f.run(f.request);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect((await f.store.today()).escalations).toHaveLength(1);
  });
  it("an uncertain claim never sends", async () => {
    const f = fixture();
    f.claim.mockRejectedValue(new Error("database timeout"));
    await expect(f.run(f.request)).rejects.toThrow("database timeout");
    expect(f.publish).not.toHaveBeenCalled();
    expect((await f.store.today()).escalations).toEqual([]);
  });
  it("does not retry an ambiguous provider failure", async () => {
    const f = fixture();
    f.publish.mockRejectedValue(new Error("response lost"));
    expect(await f.run(f.request)).toMatchObject({ status: "outcome_unknown", delivered: false });
    await f.run(f.request);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect((await f.store.today()).escalations[0]).toMatchObject({ status: "failed" });
  });
  it("rechecks routing after claiming and leaves care state untouched on change", async () => {
    const f = fixture();
    f.claim.mockImplementation(async () => { f.target.mockResolvedValue(null as unknown as PushDestination); return true; });
    expect(await f.run(f.request)).toEqual({ status: "not_ready", delivered: false });
    expect(f.publish).not.toHaveBeenCalled();
    expect((await f.store.today()).escalations).toEqual([]);
  });
});
