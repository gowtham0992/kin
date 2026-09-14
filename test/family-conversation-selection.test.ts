import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "../src/auth.js";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";
import { createFamilyConversationService, familyConversationConsentVersion } from "../src/family-conversation.js";

const config = { clientId: "kin-family-browser", issuer: "https://kin.example", redirectUri: "https://kin.example/invite.html", resource: "https://kin.example/mcp" };
const now = () => new Date("2026-09-09T09:00:00.000Z");
const member = { circleId: "family-a", memberId: "evelyn", name: "Evelyn", role: "care_recipient", status: "active" };
function task(id: string, title = "Drink a glass of water", overrides: Partial<CareTask> = {}): CareTask {
  return { id, title, dueAt: "2026-09-09T10:00:00.000Z", state: "scheduled", lastResponse: null,
    confirmedBy: null, confirmedAt: null, ...overrides };
}
function setup() {
  const store = new InMemoryCareStore([
    task("morning-water"),
    task("afternoon-water", undefined, { dueAt: "2026-09-09T16:00:00.000Z" }),
    task("question-water", "Drink a glass of water?"),
    task("call-family", "Call the family"),
    task("yesterday-water", undefined, { dueAt: "2026-09-08T10:00:00.000Z" }),
    task("done-water", undefined, { state: "done", lastResponse: "done", confirmedBy: "Evelyn", confirmedAt: "2026-09-09T08:00:00.000Z" }),
    task("skipped-water", undefined, { state: "skipped", lastResponse: "skipped", confirmedBy: "Evelyn", confirmedAt: "2026-09-09T08:00:00.000Z" }),
    task("cancelled-water", undefined, { state: "cancelled" }),
  ], now);
  const find = vi.fn(async (): Promise<unknown> => member);
  const generate = vi.fn(async () => ({ action: "today" }));
  const reserve = vi.fn(async () => {});
  const app = createHttpApp(store, undefined, {
    serveSimulator: false, serveFamilyWorkspace: true, browserAuth: config,
    accessAuthorizer: { async authorize(header) {
      if (header !== "Bearer synthetic-family") throw new AccessDeniedError(401, "invalid_token");
      return { subject: "family-a-evelyn", scopes: new Set(["mcp:tools"]), claims: { iss: config.issuer } };
    } },
    familyAccess: { circleId: "family-a", directory: { find } },
    familyConversation: createFamilyConversationService({ generate, budget: { reserve } }),
  });
  const interpret = (body: object) => request(app).post("/api/conversation").set("authorization", "Bearer synthetic-family").send(body);
  return { store, find, app, interpret, generate, reserve };
}

describe("explicit family conversation task selection", () => {
  it("reviews a unique ordinary report without a selection, model transfer, or care write", async () => {
    const { store, interpret, generate, reserve } = setup(), before = await store.today();
    const result = await interpret({ message: "I already called the family." }).expect(200);
    expect(result.body).toMatchObject({ action: "confirm", mode: "limited", taskId: "call-family", response: "done",
      expected: { title: "Call the family", state: "scheduled", confirmedAt: null } });
    expect(await store.today()).toEqual(before);
    expect(generate).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });

  it("clarifies a natural report when several occurrences could be meant", async () => {
    const { store, interpret, generate, reserve } = setup(), before = await store.today();
    await interpret({ message: "I already had my water." }).expect(200, { action: "clarify", mode: "limited" });
    expect(await store.today()).toEqual(before);
    expect(generate).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });

  it.each(["morning-water", "afternoon-water"])("reviews the selected repeated title %s without writing or invoking a model", async selectedTaskId => {
    const { store, interpret, generate, reserve } = setup();
    const before = await store.today();
    const result = await interpret({ message: "Done: Drink a glass of water", selectedTaskId }).expect(200);
    const selected = before.tasks.find(task => task.id === selectedTaskId)!;
    expect(result.body).toMatchObject({ action: "confirm", mode: "limited", taskId: selectedTaskId, response: "done",
      task: { id: selectedTaskId, title: selected.title, dueAt: selected.dueAt },
      expected: { title: selected.title, dueAt: selected.dueAt, state: "scheduled", confirmedBy: null },
    });
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(await store.today()).toEqual(before);
    expect(generate).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });

  it("keeps repeated free-text titles ambiguous without an explicit selection", async () => {
    const { interpret } = setup();
    await interpret({ message: "Done: Drink a glass of water", selectedTaskId: "afternoon-water", mode: "explicit" }).expect(200);
    await interpret({ message: "Done: Drink a glass of water" }).expect(200, { action: "clarify", mode: "limited" });
  });

  it.each(["Done: Call the family", "Done: Drink a glass of water?", "Done", "I did it"])("does not let a selected ID bypass the matching full title: %s", async message => {
    const { store, interpret } = setup();
    const before = await store.today();
    await interpret({ message, selectedTaskId: "afternoon-water" }).expect(200, { action: "clarify", mode: "limited" });
    expect(await store.today()).toEqual(before);
  });

  it.each(["foreign-family-water", "missing-water", "yesterday-water", "done-water", "skipped-water", "cancelled-water"])(
    "rejects unavailable selection %s without disclosing which condition failed", async selectedTaskId => {
      const { store, interpret } = setup();
      const before = await store.today();
      const result = await interpret({ message: "Done: Drink a glass of water", selectedTaskId })
        .expect(409, { error: "selected_task_changed_refresh_required" });
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.text).not.toContain(selectedTaskId);
      expect(await store.today()).toEqual(before);
    },
  );

  it.each(["", "a".repeat(101), "../morning-water", "morning water", null, 42, ["morning-water"], { id: "morning-water" }])(
    "rejects malformed selected IDs: %j", async selectedTaskId => {
      const { store, interpret } = setup();
      const before = await store.today();
      await interpret({ message: "Done: Drink a glass of water", selectedTaskId }).expect(400, { error: "invalid_message" });
      expect(await store.today()).toEqual(before);
    },
  );

  it("rejects selection on the Bedrock mode before model quota or provider work", async () => {
    const { store, interpret, generate, reserve } = setup();
    const before = await store.today();
    await interpret({ message: "I drank the water", selectedTaskId: "morning-water", mode: "bedrock",
      transferConsent: true, disclosureVersion: familyConversationConsentVersion }).expect(400, { error: "invalid_message" });
    expect(generate).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(await store.today()).toEqual(before);
  });

  it.each([{ ...member, role: "viewer" }, { ...member, status: "revoked" }, { ...member, circleId: "family-b" }, null])(
    "rechecks membership before reading or reviewing a selection: %j", async deniedMember => {
      const { store, interpret, find } = setup();
      await interpret({ message: "Done: Drink a glass of water", selectedTaskId: "afternoon-water" }).expect(200);
      find.mockResolvedValue(deniedMember);
      const read = vi.spyOn(store, "today");
      await interpret({ message: "Done: Drink a glass of water", selectedTaskId: "afternoon-water" }).expect(403, { error: "family_access_denied" });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("requires authentication even when an exact task ID is supplied", async () => {
    const { app, store, find } = setup();
    const read = vi.spyOn(store, "today");
    await request(app).post("/api/conversation").send({ message: "Done: Drink a glass of water", selectedTaskId: "morning-water" })
      .expect(401, { error: "invalid_token" });
    expect(find).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });

  it("keeps selected proposals subject to the existing separate confirmation and stale-review checks", async () => {
    const { app, store, interpret } = setup();
    const selectedTaskId = "afternoon-water";
    const result = await interpret({ message: "Done: Drink a glass of water", selectedTaskId }).expect(200);
    const confirm = { response: "done", expected: result.body.expected, actor: "Forged name", requestId: "selected-task-review-1" };
    expect((await store.today()).tasks.find(task => task.id === selectedTaskId)!.state).toBe("scheduled");
    const saved = await request(app).post(`/api/tasks/${selectedTaskId}/confirm`).set("authorization", "Bearer synthetic-family").send(confirm).expect(201);
    expect(saved.body.confirmation.actor).toBe("Evelyn");
    expect((await store.today()).tasks.find(task => task.id === "morning-water")!.state).toBe("scheduled");
    await request(app).post(`/api/tasks/${selectedTaskId}/confirm`).set("authorization", "Bearer synthetic-family")
      .send({ ...confirm, response: "not_yet", requestId: "selected-task-review-2" }).expect(409, { error: "review_conflict" });
  });
});
