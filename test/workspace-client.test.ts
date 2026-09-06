import { describe, expect, it, vi } from "vitest";
const { createWorkspaceClient, createPlanDraft, dutyDays } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);
const ok = (data: unknown) => ({ ok: true, json: async () => data });

describe("authenticated workspace requests", () => {
  it("materializes seven calendar days with uncovered slots across a month boundary", () => {
    const result = dutyDays({ startDate: "2026-10-29", endDate: "2026-11-04", assignments: [{ date: "2026-11-01", memberId: "maya" }] });
    expect(result.map((day: { date: string }) => day.date)).toEqual(["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(result.filter((day: { assignment: unknown }) => day.assignment === null)).toHaveLength(6);
    expect(() => dutyDays({ startDate: "2026-02-30", endDate: "2026-03-08", assignments: [] })).toThrow("Invalid coverage window");
  });
  it("retains the exact reviewed handoff on uncertain retry and releases stale conflicts", async () => {
    const request = vi.fn(async (_url: string, _options: { body: string }): Promise<unknown> => { throw new Error("Connection lost"); });
    const client = createWorkspaceClient({ request, newRequestId: () => "duty-request-1" });
    const change = { date: "2026-09-08", memberId: "maya", expectedMemberId: null };
    await expect(client.assignDuty(change)).rejects.toThrow("Connection lost");
    expect(client.pendingKind).toBe("duty handoff");
    await expect(client.assignDuty({ ...change, memberId: "theo" })).rejects.toThrow("Resolve");
    request.mockResolvedValue({ ok: false, status: 409 });
    await expect(client.retry()).rejects.toMatchObject({ status: 409 });
    expect(request.mock.calls[0]![1].body).toEqual(request.mock.calls[1]![1].body);
    expect(client.pending).toBeNull();
  });
  it("requires a matching handoff receipt and discards late responses after session reset", async () => {
    let resolve!: (value: unknown) => void;
    const request = vi.fn(async () => new Promise(done => { resolve = done; }));
    const client = createWorkspaceClient({ request, newRequestId: () => "duty-request-2" });
    const saving = client.assignDuty({ date: "2026-09-08", memberId: "maya", expectedMemberId: "theo" });
    client.reset(); resolve(ok({ requestId: "duty-request-2", assignments: [{ date: "2026-09-08", memberId: "maya" }] }));
    await expect(saving).rejects.toMatchObject({ stale: true });
    expect(client.pending).toBeNull();
  });
  it("clears a definitively rejected reviewed check-in so the user can review again", async () => {
    const request = vi.fn(async () => ({ ok: false, status: 409 }));
    const client = createWorkspaceClient({ request, newRequestId: () => "review-request-1" });
    await expect(client.confirm({ taskId: "water", response: "done", actor: "Maya", expected: { state: "scheduled" } })).rejects.toMatchObject({ status: 409, definitiveRejection: true });
    expect(client.pending).toBeNull();
  });
  it("keeps scheduling drafts separate from render copies and clears every field on reset", () => {
    const draft = createPlanDraft();
    draft.update({ title: "Call together", due: "2026-09-08T12:00", repeat: "7", password: "must-not-be-retained" });
    const copy = draft.read(); copy.title = "Changed render copy";
    expect(draft.read()).toEqual({ title: "Call together", due: "2026-09-08T12:00", repeat: "7" });
    draft.clear();
    expect(draft.read()).toEqual({ title: "", due: "", repeat: "1" });
  });
  it("retries a routine change unchanged after a lost response and clears a stale-review conflict", async () => {
    const request = vi.fn(async (_url: string, _options: { body: string }): Promise<{ ok: boolean; status?: number }> => { throw new Error("connection lost"); });
    const client = createWorkspaceClient({ request, newRequestId: () => "change-request" });
    const input = { routineId: "routine", action: "cancel", confirm: true, expected: [{ id: "task", title: "Call", dueAt: "2026-09-08T12:00:00.000Z" }] };
    await expect(client.changeRoutine(input)).rejects.toThrow("connection lost");
    request.mockImplementation(async () => ({ ok: false, status: 409 }));
    await expect(client.retry()).rejects.toMatchObject({ status: 409 });
    expect(request.mock.calls[0]![1].body).toBe(request.mock.calls[1]![1].body);
    expect(JSON.parse(request.mock.calls[0]![1].body)).not.toHaveProperty("routineId");
    expect(client.pending).toBeNull();
  });
  it("retries the exact routine after a partial receipt and refuses changing its dates", async () => {
    const dueAts = ["2026-09-06T12:00:00.000Z", "2026-09-07T12:00:00.000Z"];
    const request = vi.fn(async (_url: string, options: { body: string }) => {
      const body = JSON.parse(options.body);
      return ok({ requestId: body.requestId, tasks: [{ title: body.title, dueAt: dueAts[0] }] });
    });
    const client = createWorkspaceClient({ request, newRequestId: () => "routine-request" });
    const input = { title: "Call together", dueAts, timeZone: "UTC" };
    await expect(client.schedule(input)).rejects.toThrow("Receipt mismatch");
    await expect(client.schedule({ ...input, dueAts: dueAts.slice(0, 1) })).rejects.toThrow("pending task");
    request.mockImplementation(async (_url, options) => { const body = JSON.parse(options.body);
      return ok({ requestId: body.requestId, tasks: dueAts.map(dueAt => ({ title: body.title, dueAt })) }); });
    await client.retry();
    expect(request.mock.calls.map(call => call[0])).toEqual(["/api/routines", "/api/routines"]);
    expect(request.mock.calls[0]![1].body).toBe(request.mock.calls[1]![1].body);
    expect(client.pending).toBeNull();
  });
  it("keeps one scheduling identity after an uncertain response and rejects changed input", async () => {
    const request = vi.fn(async (_url: string, options: { body: string }) => {
      const body = JSON.parse(options.body);
      return ok({ requestId: body.requestId, task: { title: body.title, dueAt: body.dueAt } });
    });
    request.mockRejectedValueOnce(new Error("connection lost"));
    const client = createWorkspaceClient({ request, newRequestId: () => "schedule-request" });
    const input = { title: "Call together", dueAt: "2026-09-06T12:00:00.000Z" };
    await expect(client.schedule(input)).rejects.toThrow("connection lost");
    await expect(client.schedule({ ...input, title: "Different" })).rejects.toThrow("pending task");
    await client.retry();
    expect(request.mock.calls[0]![1].body).toBe(request.mock.calls[1]![1].body);
    expect(client.pending).toBeNull();
  });
  it("rejects a mismatched receipt and retries the original confirmation identity", async () => {
    const request = vi.fn(async (_url: string, options: { body: string }) => {
      const body = JSON.parse(options.body);
      return ok({ confirmation: { ...body, taskId: "wrong" } });
    });
    const client = createWorkspaceClient({ request, newRequestId: () => "stable-request" });
    await expect(client.confirm({ taskId: "water", response: "done", actor: "Maya" })).rejects.toThrow("Receipt mismatch");
    expect(client.pending.requestId).toBe("stable-request");
    request.mockImplementation(async (_url, options) => ok({ confirmation: { ...JSON.parse(options.body), taskId: "water" } }));
    await client.retry();
    expect(request.mock.calls[0]![1].body).toBe(request.mock.calls[1]![1].body);
    expect(client.pending).toBeNull();
  });
  it("discards data that finishes decoding after the workspace session closes", async () => {
    let resolve!: (value: unknown) => void;
    const body = new Promise(done => { resolve = done; });
    const parsing = vi.fn(() => body);
    const client = createWorkspaceClient({ request: async () => ({ ok: true, json: parsing }) });
    const read = client.today();
    await vi.waitFor(() => expect(parsing).toHaveBeenCalled());
    client.reset(); resolve({ privateData: "old family" });
    await expect(read).rejects.toMatchObject({ stale: true });
  });
  it("clears a definitively denied check-in without retrying it", async () => {
    const request = vi.fn(async () => ({ ok: false, status: 403 }));
    const client = createWorkspaceClient({ request, newRequestId: () => "denied-request" });
    await expect(client.confirm({ taskId: "water", response: "done", actor: "Maya" })).rejects.toMatchObject({ status: 403 });
    expect(client.pending).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
  });
});
