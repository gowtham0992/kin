import { describe, expect, it } from "vitest";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { confirmWithReceipt, undoCompletionWithReceipt } from "../src/confirmation.js";
import { CompletionUndoConflict, completionUndoLifetime } from "../src/response-undo.js";
import { taskReview } from "../src/task-review.js";
import { authorizeCareWrite } from "../src/care-write-authorization.js";
import { FamilyAccessDeniedError, type Membership } from "../src/membership.js";

const at = Date.parse("2026-09-13T16:00:00.000Z");
const task: CareTask = { id: "water", title: "Morning water", dueAt: "2026-09-13T15:00:00.000Z", state: "scheduled",
  lastResponse: null, confirmedAt: null, confirmedBy: null };
function fixture(initial = task) {
  let now = at;
  const store = new InMemoryCareStore([initial], () => new Date(now));
  const member: Membership = { circleId: "family", memberId: "parent", name: "Parent", role: "care_recipient", status: "active" };
  let current: Membership | null = member;
  const authorization = () => authorizeCareWrite({ circleId: "family", directory: { async find() { return current; } } },
    { subject: "linked", claims: { iss: "https://issuer.invalid" }, scopes: new Set(["mcp:tools"]) }, member, "confirm");
  const confirm = () => confirmWithReceipt(store, { taskId: task.id, response: "done", actor: "ignored", requestId: "original-completion", expected: taskReview(initial) }, member, authorization());
  return { store, member, authorization, confirm, advance: (ms: number) => { now += ms; }, revoke: () => { current = null; } };
}
async function prepare(initial = task) {
  const f = fixture(initial), saved = await f.confirm();
  const input = { taskId: task.id, confirmationRequestId: saved.confirmation.requestId,
    requestId: "undo-completion", confirm: true as const, expected: taskReview(saved.task), restore: taskReview(initial) };
  return { ...f, saved, input, undo: () => undoCompletionWithReceipt(f.store, input, f.member, f.authorization()) };
}

describe("bounded completion undo", () => {
  it("restores the untouched scheduled response while retaining the original completion receipt", async () => {
    const f = await prepare();
    const undone = await f.undo();
    expect(undone).toMatchObject({ task, replayed: false, undo: { taskId: task.id, confirmationRequestId: "original-completion", actor: "Parent", restored: taskReview(task) } });
    expect((await f.store.today()).tasks).toEqual([task]);
    const original = await f.confirm();
    expect(original.replayed).toBe(true);
    expect(original.confirmation).toEqual(f.saved.confirmation);
    expect(original.confirmation).not.toHaveProperty("before");
    expect((await f.store.today()).tasks).toEqual([task]);
  });
  it("restores the prior not-yet timestamp without granting a new response grace period", async () => {
    const previous = { ...task, lastResponse: "not_yet" as const, confirmedAt: "2026-09-13T15:10:00.000Z", confirmedBy: "Parent earlier" };
    const f = await prepare(previous);
    f.advance(120_000);
    expect((await f.undo()).task).toEqual(previous);
    expect((await f.store.today()).tasks).toEqual([previous]);
  });
  it("replays a successful undo after expiry and a later response without another mutation", async () => {
    const f = await prepare();
    const first = await f.undo();
    const later = await confirmWithReceipt(f.store, { taskId: task.id, response: "skipped", actor: "ignored", requestId: "later-response", expected: taskReview(task) }, f.member, f.authorization());
    f.advance(completionUndoLifetime + 1);
    expect(await f.undo()).toEqual({ ...first, replayed: true });
    expect((await f.store.today()).tasks).toEqual([later.task]);
  });
  it.each([completionUndoLifetime + 1, -1])("rejects a first undo outside the freshness interval: %s", async elapsed => {
    const f = await prepare(); f.advance(elapsed);
    await expect(f.undo()).rejects.toBeInstanceOf(CompletionUndoConflict);
    expect((await f.store.today()).tasks).toEqual([f.saved.task]);
  });
  it("accepts the exact freshness boundary", async () => {
    const f = await prepare(); f.advance(completionUndoLifetime);
    expect((await f.undo()).task).toEqual(task);
  });
  it("rejects a newer equal-valued completion recorded in the same millisecond", async () => {
    const f = await prepare();
    const later = await confirmWithReceipt(f.store, { taskId: task.id, response: "done", actor: "ignored", requestId: "newer-completion", expected: taskReview(f.saved.task) }, f.member, f.authorization());
    expect(later.task).toEqual(f.saved.task);
    await expect(f.undo()).rejects.toBeInstanceOf(CompletionUndoConflict);
  });
  it("cannot undo another linked member's receipt even when their display names match", async () => {
    const f = await prepare();
    const other = { ...f.member, memberId: "other-member" };
    const authorization = authorizeCareWrite({ circleId: "family", directory: { async find() { return other; } } },
      { subject: "other", claims: { iss: "https://issuer.invalid" }, scopes: new Set(["mcp:tools"]) }, other, "confirm");
    await expect(undoCompletionWithReceipt(f.store, f.input, other, authorization)).rejects.toBeInstanceOf(CompletionUndoConflict);
    expect((await f.store.today()).tasks).toEqual([f.saved.task]);
  });
  it.each(["first", "replay"])("checks current membership for %s undo", async mode => {
    const f = await prepare(); if (mode === "replay") await f.undo(); f.revoke();
    await expect(f.undo()).rejects.toBeInstanceOf(FamilyAccessDeniedError);
  });
  it("rejects changed review fields and reused undo IDs for another original completion", async () => {
    const f = await prepare();
    await expect(undoCompletionWithReceipt(f.store, { ...f.input, expected: { ...f.input.expected, title: "other" } }, f.member, f.authorization())).rejects.toBeInstanceOf(CompletionUndoConflict);
    await f.undo();
    await expect(undoCompletionWithReceipt(f.store, { ...f.input, confirmationRequestId: "other-completion" }, f.member, f.authorization())).rejects.toBeInstanceOf(CompletionUndoConflict);
  });
  it("requires explicit consent and a current authorized member", async () => {
    const f = await prepare();
    await expect(undoCompletionWithReceipt(f.store, { ...f.input, confirm: false } as never, f.member, f.authorization())).rejects.toThrow();
    await expect(undoCompletionWithReceipt(f.store, f.input, undefined, undefined)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
    expect((await f.store.today()).tasks).toEqual([f.saved.task]);
  });
});
