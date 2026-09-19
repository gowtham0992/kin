import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createPushTest, type PushTestApproval } from "../src/push-test.js";
import { runConfiguredPushTest } from "../src/push-test-runtime.js";
import type { PushDestination } from "../src/web-push.js";

const approval: PushTestApproval = { id: "4cde63d4-cfe0-4c06-b60e-7aa31a78ab69", memberId: "caregiver",
  subscriptionId: "a".repeat(64), expiresAt: "2026-09-15T03:10:00.000Z" };
const event = { source: "kin.push-test", approvalId: approval.id, action: "send", consent: true };
function fixture() {
  let claimed = false;
  const target = vi.fn(async () => ({ id: approval.subscriptionId, subscription: {} } as PushDestination));
  const send = vi.fn(async (_target: PushDestination) => {}), finish = vi.fn(async () => {});
  const claim = vi.fn(async () => { if (claimed) return false; claimed = true; return true; });
  const onDuty = vi.fn(async () => true);
  const input = { approval, target, send, finish, claim, onDuty, now: () => Date.parse("2026-09-15T03:00:00Z") };
  return { ...input, run: createPushTest(input) };
}
describe("one approved push attempt", () => {
  it("inspects without claiming or sending", async () => {
    const f = fixture(); expect(await f.run({ ...event, action: "inspect" })).toEqual({ status: "ready", delivered: false });
    expect(f.claim).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("allows one concurrent send and rejects replay without claiming delivery", async () => {
    const f = fixture(); const results = await Promise.all([f.run(event), f.run(event)]);
    expect(results.map(r => r.status).sort()).toEqual(["already_attempted", "provider_accepted"]);
    expect(f.send).toHaveBeenCalledOnce(); expect(results.every(r => r.delivered === false)).toBe(true);
    expect((await f.run(event)).status).toBe("already_attempted"); expect(f.send).toHaveBeenCalledOnce();
  });
  it.each([{ ...event, consent: false }, { ...event, memberId: "other" }, { ...event, approvalId: "bad" },
    { ...event, action: "sweep" }])("rejects unreviewed request %j", async bad => {
    const f = fixture(); await expect(f.run(bad)).rejects.toThrow("Invalid push test request");
    expect(f.claim).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each([0, 900001, -1])("refuses invalid approval window %i", async remaining => {
    const f = fixture(); const run = createPushTest({ ...f, now: () => Date.parse(approval.expiresAt) - remaining });
    expect((await run(event)).status).toBe("not_ready"); expect(f.claim).not.toHaveBeenCalled();
  });
  it("refuses an off-duty caregiver", async () => {
    const f = fixture(); f.onDuty.mockResolvedValue(false);
    expect((await f.run(event)).status).toBe("not_ready"); expect(f.send).not.toHaveBeenCalled();
  });
  it("refuses a different or revoked phone", async () => {
    const f = fixture(); f.target.mockResolvedValue({ id: "b".repeat(64), subscription: {} } as PushDestination);
    expect((await f.run(event)).status).toBe("not_ready"); expect(f.claim).not.toHaveBeenCalled();
  });
  it("rechecks duty after claiming and never reopens the consumed approval", async () => {
    const f = fixture(); f.onDuty.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await f.run(event)).status).toBe("not_ready"); expect(f.send).not.toHaveBeenCalled();
    f.onDuty.mockResolvedValue(true); expect((await f.run(event)).status).toBe("already_attempted");
  });
  it("does not retry a provider timeout", async () => {
    const f = fixture(); f.send.mockRejectedValue(new Error("PRIVATE ENDPOINT"));
    expect(await f.run(event)).toEqual({ status: "outcome_unknown", delivered: false });
    expect((await f.run(event)).status).toBe("already_attempted"); expect(f.send).toHaveBeenCalledOnce();
  });
  it("does not resend after receipt persistence fails", async () => {
    const f = fixture(); f.finish.mockRejectedValue(new Error("database unavailable"));
    expect((await f.run(event)).status).toBe("outcome_unknown");
    expect((await f.run(event)).status).toBe("already_attempted"); expect(f.send).toHaveBeenCalledOnce();
  });
  it("fails closed on uncertain claim without sending", async () => {
    const f = fixture(); f.claim.mockRejectedValue(new Error("timeout"));
    await expect(f.run(event)).rejects.toThrow(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each([{}, { KIN_PUSH_TEST_ENABLED: "true", KIN_ESCALATION_WORKER_ENABLED: "true" },
    { KIN_PUSH_TEST_ENABLED: "true", KIN_ESCALATION_WORKER_ENABLED: "false", KIN_WEB_PUSH_ENABLED: "false" }])(
    "cannot construct a live test while disabled or general delivery is active", async environment => {
      await expect(runConfiguredPushTest(environment, event)).rejects.toThrow("Push test unavailable");
    });
  it("renders a fixed test label and ignores supplied private text", async () => {
    let handle: (event: unknown) => void = () => {}; let pending: Promise<unknown> | undefined;
    const showNotification = vi.fn(async () => {});
    runInNewContext(readFileSync(new URL("../simulator/kin-sw.js", import.meta.url), "utf8"), {
      self: { addEventListener: (name: string, fn: typeof handle) => { if (name === "push") handle = fn; }, registration: { showNotification } },
    });
    handle({ data: { json: () => ({ version: 1, kind: "connection_test", tag: "a".repeat(32), title: "PRIVATE", body: "PRIVATE" }) },
      waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
    expect(showNotification.mock.calls).toEqual([["Kin · Test notification", expect.objectContaining({
      body: "Your Kin phone connection test. No care action is needed.", data: { path: "/invite.html#today" },
    })]]);
  });
});
