import { describe, expect, it, vi } from "vitest";

const clientModule = new URL("../simulator/care-client.js", import.meta.url).href;
const { createConfirmationSender, createSnapshotReader } = await import(clientModule);

describe("care view request coordination", () => {
  it("reuses the same idempotency key after an ambiguous network failure", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce({ saved: true });
    const newRequestId = vi.fn(() => "stable-request-1");
    const sender = createConfirmationSender({ send, newRequestId });
    await expect(sender.confirm({ taskId: "water", response: "done", actor: "Evelyn" })).rejects.toThrow();
    expect(sender.pending.requestId).toBe("stable-request-1");
    await sender.retry();
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    expect(newRequestId).toHaveBeenCalledTimes(1);
    expect(sender.pending).toBeNull();
  });

  it("does not replace an uncertain write with a different task or response", async () => {
    const send = vi.fn().mockRejectedValue(new Error("timeout"));
    const sender = createConfirmationSender({ send, newRequestId: () => "stable-request-2" });
    await expect(sender.confirm({ taskId: "water", response: "done", actor: "Evelyn" })).rejects.toThrow();
    await expect(sender.confirm({ taskId: "walk", response: "done", actor: "Evelyn" })).rejects.toThrow("Resolve");
    expect(send).toHaveBeenCalledTimes(1);
    expect(sender.pending.taskId).toBe("water");
  });

  it("coalesces double submits and clears definitively rejected input", async () => {
    const send = vi.fn().mockRejectedValue({ definitiveRejection: true });
    const sender = createConfirmationSender({ send, newRequestId: () => "stable-request-3" });
    const input = { taskId: "water", response: "done", actor: "Evelyn" };
    const first = sender.confirm(input);
    const second = sender.confirm(input);
    expect(first).toBe(second);
    await Promise.allSettled([first, second]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sender.pending).toBeNull();
  });

  it("ignores a pre-mutation read that arrives after a newer state", async () => {
    let finishOld!: (value: unknown) => void;
    const old = new Promise(resolve => { finishOld = resolve; });
    const onSnapshot = vi.fn();
    const reader = createSnapshotReader({
      fetchSnapshot: vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce({ completed: 1 }),
      onSnapshot, onError: vi.fn(),
    });
    const stale = reader.read();
    reader.invalidate();
    await reader.read();
    finishOld({ completed: 0 });
    await stale;
    expect(onSnapshot.mock.calls).toEqual([[{ completed: 1 }]]);
  });
});
