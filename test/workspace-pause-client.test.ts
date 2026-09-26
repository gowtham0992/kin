import { describe, expect, it, vi } from "vitest";
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);
const task = { id: "call", title: "A call", dueAt: "2026-09-14T17:00:00.000Z" };
const proposal = { startsAt: "2026-09-13T15:00:00.000Z", endsAt: "2026-09-20T15:00:00.000Z", expiresAt: "2026-09-13T15:05:00.000Z",
  durationHours: 168, timeZone: "America/Denver", reviewToken: "a".repeat(64), tasks: [task], nextTask: null };
const requestId = "pause-review-1";
const pause = { requestId, startsAt: proposal.startsAt, endsAt: proposal.endsAt, recordedAt: proposal.startsAt, actor: "Parent" };
const result = { receipt: { ...pause, timeZone: proposal.timeZone, cancelled: [task], nextTask: null },
  control: { version: 1, pause }, cancelledTasks: [{ ...task, state: "cancelled", lastResponse: null, confirmedAt: null, confirmedBy: null }], replayed: false };
const ok = (data: unknown) => ({ ok: true, json: async () => data });
describe("reviewed plan-pause client", () => {
  it("fetches a read-only proposal and retries exactly once per explicit call after an uncertain response", async () => {
    const request = vi.fn(async (_url: string, options: { body?: string } = {}) => { if (options.body) throw new Error("Lost receipt"); return ok({ control: { version: 0 }, proposal }); });
    const client = createWorkspaceClient({ request, newRequestId: () => requestId });
    expect(await client.proposePlanPause()).toMatchObject({ proposal });
    await expect(client.pausePlan(proposal)).rejects.toThrow("Lost receipt");
    expect(client.pendingKind).toBe("plan pause");
    for (const action of [() => client.changeTask({}), () => client.schedule({}), () => client.changeRoutine({}), () => client.confirm({}),
      () => client.prepareUndo(), () => client.undoCompletion(), () => client.assignDuty({}), () => client.changeRoster({}), () => client.acceptDutyRotation({})]) {
      await expect(action()).rejects.toThrow(/pending|pause/);
    }
    request.mockImplementation(async () => ok(result));
    expect(await client.retry()).toEqual(result); expect(client.pending).toBeNull();
    const posts = request.mock.calls.filter(([, options]) => options?.body);
    expect(posts).toHaveLength(2); expect(posts[0]![1]!.body).toBe(posts[1]![1]!.body);
    expect(JSON.parse(posts[0]![1]!.body!)).toEqual({ startsAt: proposal.startsAt, endsAt: proposal.endsAt, reviewToken: proposal.reviewToken, requestId, confirm: true });
  });
  it.each([{ receipt: { ...result.receipt, cancelled: [] } }, { control: { ...result.control, pause: { ...pause, endsAt: "2026-09-21T15:00:00.000Z" } } },
    { cancelledTasks: [] }, { receipt: { ...result.receipt, requestId: "wrong" } }])("keeps mismatched pause receipt %j pending", async patch => {
    const client = createWorkspaceClient({ request: async () => ok({ ...result, ...patch }), newRequestId: () => requestId });
    await expect(client.pausePlan(proposal)).rejects.toThrow("Receipt mismatch"); expect(client.pendingKind).toBe("plan pause");
  });
  it.each([400, 404, 409])("clears a definitive no-write status %s", async status => {
    const client = createWorkspaceClient({ request: async () => ({ ok: false, status }), newRequestId: () => requestId });
    await expect(client.pausePlan(proposal)).rejects.toMatchObject({ status }); expect(client.pending).toBeNull();
  });
  it.each([401, 403])("preserves an unconfirmed pause reference on initial access denial %s until session reset", async status => {
    const request = vi.fn(async () => ({ ok: false, status }));
    const client = createWorkspaceClient({ request, newRequestId: () => requestId });
    await expect(client.pausePlan(proposal)).rejects.toMatchObject({ status, outcomeUnknown: true, definitiveRejection: false });
    expect(client.pending.requestId).toBe(requestId);
    client.reset(); expect(client.pending).toBeNull(); expect(request).toHaveBeenCalledOnce();
  });
  it("rejects late receipts after reset and never restores a private pending draft", async () => {
    let release!: (value: unknown) => void;
    const client = createWorkspaceClient({ request: () => new Promise(resolve => { release = resolve; }), newRequestId: () => requestId });
    const saving = client.pausePlan(proposal); client.reset(); release(ok(result));
    await expect(saving).rejects.toMatchObject({ stale: true }); expect(client.pending).toBeNull();
  });
  it("retains an opaque pending identity for session closure if access is lost after an uncertain write", async () => {
    const request = vi.fn(async (): Promise<unknown> => { throw new Error("Lost receipt"); });
    const client = createWorkspaceClient({ request, newRequestId: () => requestId });
    await expect(client.pausePlan(proposal)).rejects.toThrow("Lost receipt");
    request.mockResolvedValue({ ok: false, status: 403 });
    await expect(client.retry()).rejects.toMatchObject({ status: 403, outcomeUnknown: true });
    expect(client.pending).toMatchObject({ requestId }); client.reset(); expect(client.pending).toBeNull();
  });
});
