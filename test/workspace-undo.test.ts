import { describe, expect, it, vi } from "vitest";
const { createCompletionUndo } = await import(new URL("../simulator/completion-undo.js", import.meta.url).href);
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);

const at = Date.parse("2026-09-13T16:00:00.000Z");
const before = { title: "A glass of water", dueAt: "2026-09-13T15:00:00.000Z", state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null };
const task = { id: "water", ...before, state: "done", lastResponse: "done", confirmedAt: new Date(at).toISOString(), confirmedBy: "Maya" };
const session = { memberId: "maya", role: "caregiver", permissions: { confirm: true }, features: { completionUndo: true, completionUndoWindowSeconds: 300 } };
const input = { taskId: task.id, response: "done", requestId: "completion-0001", expected: before };
const saved = { confirmation: { id: "confirmation_member_123", requestId: input.requestId, taskId: task.id, taskDueAt: task.dueAt, response: "done", actor: "Maya", recordedAt: task.confirmedAt }, task, snapshot: { tasks: [task] } };
function fixture(previous: Record<string, any> = before) {
  let time = at;
  const send = vi.fn(async (value: any) => ({ undo: { id: "undo_member_123", requestId: value.requestId, confirmationRequestId: value.confirmationRequestId,
    taskId: value.taskId, taskDueAt: value.expected.dueAt, actor: "Maya", recordedAt: new Date(time).toISOString(), restored: value.restore }, task: { id: value.taskId, ...value.restore }, replayed: false }));
  const undo = createCompletionUndo({ send, now: () => time, newRequestId: () => "undo-request-0001" });
  undo.configure(session); undo.record({ ...input, expected: previous }, saved);
  return { undo, send, advance(ms: number) { time += ms; } };
}

describe("session-only reviewed completion undo", () => {
  it("requires backend availability, own latest receipt and matching follow-up snapshot", () => {
    const f = fixture(); expect(f.undo.offer({ tasks: [task] })).toMatchObject({ taskId: "water", restore: before });
    f.undo.configure({ ...session, features: undefined }); expect(f.undo.offer({ tasks: [task] })).toBeNull();
    f.undo.configure(session); f.undo.record(input, { ...saved, snapshot: null }); expect(f.undo.offer({ tasks: [task] })).toBeNull();
    f.undo.record(input, { ...saved, confirmation: { ...saved.confirmation, taskId: "other" } }); expect(f.undo.offer({ tasks: [task] })).toBeNull();
  });
  it("requires fresh explicit review and restores exact prior not-yet attribution and time", async () => {
    const previous = { ...before, lastResponse: "not_yet", confirmedAt: "2026-09-13T15:10:00.000Z", confirmedBy: "Theo" };
    const f = fixture(previous);
    await expect(f.undo.confirm()).rejects.toThrow("Review"); expect(f.send).not.toHaveBeenCalled();
    expect(f.undo.prepare({ tasks: [task] })).toMatchObject({ restore: previous });
    f.advance(10_000); const result = await f.undo.confirm();
    expect(result.task).toEqual({ id: "water", ...previous });
    const { id: _id, ...expected } = task;
    expect(f.send.mock.calls[0]?.[0]).toEqual({ taskId: "water", confirmationRequestId: input.requestId, requestId: "undo-request-0001", expected, restore: previous, confirm: true });
    expect(f.undo.pending).toBeNull(); expect(f.undo.offer({ tasks: [task] })).toBeNull();
  });
  it.each([300_001, -1])("does not offer a completion outside the five-minute window (%s)", elapsed => {
    const f = fixture(); f.advance(elapsed); expect(f.undo.offer({ tasks: [task] })).toBeNull();
  });
  it("expires consent without extending the completion window and allows the exact boundary", async () => {
    const f = fixture(); f.undo.prepare({ tasks: [task] }); f.advance(90_001);
    await expect(f.undo.confirm()).rejects.toThrow("expired"); expect(f.send).not.toHaveBeenCalled();
    f.advance(209_999); expect(f.undo.prepare({ tasks: [task] })).toBeTruthy(); await f.undo.confirm();
  });
  it("rejects changed state before review and clears on another successful response or identity", () => {
    const f = fixture(); expect(() => f.undo.prepare({ tasks: [{ ...task, confirmedBy: "Theo" }] })).toThrow("changed");
    f.undo.record(input, saved); f.undo.configure({ ...session, memberId: "theo" }); expect(f.undo.offer({ tasks: [task] })).toBeNull();
    f.undo.configure(session); f.undo.record(input, saved); f.undo.record({ ...input, response: "not_yet" }, saved); expect(f.undo.offer({ tasks: [task] })).toBeNull();
  });
  it("keeps one exact retry after a lost response, including after expiration", async () => {
    const f = fixture(); f.undo.prepare({ tasks: [task] }); f.send.mockRejectedValueOnce(new Error("lost response"));
    await expect(f.undo.confirm()).rejects.toThrow("lost response"); const pending = f.undo.pending;
    f.advance(400_000); await f.undo.retry();
    expect(f.send.mock.calls[1]?.[0]).toEqual(pending); expect(f.send.mock.calls[1]?.[0]).toEqual(f.send.mock.calls[0]?.[0]);
    expect(f.undo.pending).toBeNull();
  });
  it.each(["requestId", "confirmationRequestId", "taskId", "taskDueAt", "restored"]) ("retains uncertain undo when receipt %s mismatches", async field => {
    const f = fixture(); f.undo.prepare({ tasks: [task] });
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async value => { const receipt = await original(value); return { ...receipt, undo: { ...receipt.undo, [field]: field === "restored" ? { ...before, lastResponse: "not_yet" } : "wrong" } }; });
    await expect(f.undo.confirm()).rejects.toThrow("Receipt mismatch"); expect(f.undo.pending).not.toBeNull();
  });
  it("single-flights double submit and discards a late result after reset", async () => {
    const f = fixture(); f.undo.prepare({ tasks: [task] }); let finish!: (value: any) => void;
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(value => new Promise(resolve => { finish = () => resolve(original(value)); }));
    const one = f.undo.confirm(), two = f.undo.confirm(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    f.undo.reset(); finish(null); await expect(one).rejects.toMatchObject({ stale: true }); await expect(two).rejects.toMatchObject({ stale: true }); expect(f.undo.pending).toBeNull();
  });
  it("clears definitive conflict but treats lost access as an uncertain closed session", async () => {
    const f = fixture(); f.undo.prepare({ tasks: [task] }); f.send.mockRejectedValueOnce(Object.assign(new Error("conflict"), { status: 409 }));
    await expect(f.undo.confirm()).rejects.toMatchObject({ status: 409 }); expect(f.undo.pending).toBeNull();
    f.undo.record(input, saved); f.undo.prepare({ tasks: [task] }); f.send.mockRejectedValueOnce(Object.assign(new Error("revoked"), { status: 403 }));
    await expect(f.undo.confirm()).rejects.toMatchObject({ status: 403, outcomeUnknown: true }); expect(f.undo.pending).not.toBeNull();
  });
});

describe("workspace undo request integration", () => {
  async function clientFixture() {
    let counter = 0;
    const requests: { url: string; body: any }[] = [];
    const request = vi.fn(async (url: string, options: { body?: string } = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined; requests.push({ url, body });
      let data: any;
      if (url === "/api/session") data = session;
      else if (url === "/api/today") data = { tasks: [task] };
      else if (url.endsWith("/confirm")) data = { ...saved, confirmation: { ...saved.confirmation, requestId: body.requestId } };
      else if (url.endsWith("/undo")) throw new Error("lost response");
      else throw new Error(`Unexpected request ${url}`);
      return { ok: true, json: async () => data };
    });
    const client = createWorkspaceClient({ request, now: () => at, newRequestId: () => `reviewed-request-${++counter}` });
    await client.session(); await client.confirm(input);
    return { client, request, requests };
  }
  it("freshly checks session and task before review, then locks all competing mutations after an uncertain undo", async () => {
    const f = await clientFixture(); await f.client.prepareUndo();
    expect(f.requests.slice(-2).map(value => value.url)).toEqual(["/api/session", "/api/today"]);
    await expect(f.client.undoCompletion()).rejects.toThrow("lost response");
    expect(f.client.pendingKind).toBe("completion undo"); const original = structuredClone(f.client.pending);
    expect(f.requests.at(-1)).toEqual({ url: "/api/tasks/water/undo", body: { confirmationRequestId: "reviewed-request-1", requestId: "reviewed-request-2", expected: original.expected, restore: before, confirm: true } });
    for (const action of [() => f.client.confirm(input), () => f.client.confirmViaMcp(input), () => f.client.schedule({}), () => f.client.changeTask({}),
      () => f.client.changeRoutine({}), () => f.client.assignDuty({}), () => f.client.acceptDutyRotation({}), () => f.client.changeRoster({}),
      () => f.client.acknowledge("alert"), () => f.client.revoke("member")]) await expect(action()).rejects.toThrow("undo");
    expect(f.requests.filter(value => value.url.endsWith("/undo"))).toHaveLength(1);
    await expect(f.client.retry()).rejects.toThrow("lost response");
    expect(f.client.pending).toEqual(original); expect(f.requests.at(-1)).toEqual(f.requests.at(-2));
  });
  it("retains no offer across client reset, identity change or viewer/disabled capability", async () => {
    const f = await clientFixture(); expect(f.client.undoOffer({ tasks: [task] })).not.toBeNull();
    f.client.reset(); expect(f.client.undoOffer({ tasks: [task] })).toBeNull();
    for (const identity of [{ ...session, role: "viewer" }, { ...session, features: undefined }, { ...session, permissions: { confirm: false } }]) {
      f.request.mockResolvedValue({ ok: true, json: async () => identity }); await f.client.session();
      expect(f.client.undoOffer({ tasks: [task] })).toBeNull();
    }
  });
});
