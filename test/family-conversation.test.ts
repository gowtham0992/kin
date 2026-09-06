import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { createBedrockIntentGenerator } from "../src/demo-conversation.js";
import { BudgetExceeded, ConsentRequired, ModelUnavailable, createFamilyConversationService, familyConversationConsentVersion } from "../src/family-conversation.js";
import { FamilyAccessDeniedError, type Membership } from "../src/membership.js";

const member: Membership = { circleId: "family-private", memberId: "maya", name: "Maya", status: "active", role: "caregiver" };
const store = () => createDemoStore(() => new Date("2026-09-06T15:00:00.000Z"));
afterEach(() => vi.restoreAllMocks());

describe("consented family conversation proposals", () => {
  it.each([false, "true"])("requires literal per-request consent (%s) before quota or provider access", async consent => {
    const reserve = vi.fn(), generate = vi.fn();
    const service = createFamilyConversationService({ budget: { reserve }, generate });
    await expect(service.propose({ message: "I drank the water", consent: consent as boolean }, await store().today(), member)).rejects.toBeInstanceOf(ConsentRequired);
    expect(reserve).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    expect(familyConversationConsentVersion).toBe("bedrock-task-titles-v1");
  });

  it("also rejects a viewing-only member at the service boundary", async () => {
    const reserve = vi.fn(), generate = vi.fn();
    await expect(createFamilyConversationService({ budget: { reserve }, generate }).propose(
      { message: "Water done", consent: true }, await store().today(), { ...member, role: "viewer" },
    )).rejects.toBeInstanceOf(FamilyAccessDeniedError);
    expect(reserve).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });

  it("waits for quota reservation, transfers only task identifiers/titles, and cannot save a proposal", async () => {
    let release!: () => void;
    const reservation = new Promise<void>(done => { release = done; });
    const reserve = vi.fn(() => reservation);
    const generate = vi.fn(async () => ({ action: "confirm", taskId: "morning-water", response: "done" }));
    const repository = store(), snapshot = await repository.today(), confirm = vi.spyOn(repository, "confirm");
    const before = structuredClone(snapshot);
    const pending = createFamilyConversationService({ budget: { reserve }, generate }).propose({ message: " I drank the water ", consent: true }, snapshot, member);
    expect(reserve).toHaveBeenCalledWith({ circleId: member.circleId, memberId: member.memberId });
    expect(generate).not.toHaveBeenCalled();
    release();
    expect(await pending).toMatchObject({ action: "confirm", mode: "bedrock", task: { id: "morning-water" }, expected: { state: "scheduled", confirmedBy: null } });
    expect(generate).toHaveBeenCalledWith("I drank the water", snapshot.tasks.map(({ id, title }) => ({ id, title })), undefined);
    expect(confirm).not.toHaveBeenCalled(); expect(snapshot).toEqual(before);
    expect((await repository.today()).summary.completed).toBe(0);
  });

  it("declines overlarge task context without reserving or silently sending a partial plan", async () => {
    const reserve = vi.fn(), generate = vi.fn();
    const snapshot = await store().today();
    snapshot.tasks = Array.from({ length: 41 }, (_, index) => ({ ...snapshot.tasks[0]!, id: `task-${index}` }));
    const service = createFamilyConversationService({ budget: { reserve }, generate });
    expect(await service.propose({ message: "I did the task", consent: true }, snapshot, member)).toEqual({ action: "clarify", mode: "limited" });
    expect(reserve).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    snapshot.tasks.pop(); generate.mockResolvedValue({ action: "clarify" });
    expect(await service.propose({ message: "I did the task", consent: true }, snapshot, member)).toEqual({ action: "clarify", mode: "bedrock" });
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each([new BudgetExceeded(), new Error("private storage metadata")])("never invokes the model after a failed reservation", async failure => {
    const reserve = vi.fn(async () => { throw failure; }), generate = vi.fn();
    const error = await createFamilyConversationService({ budget: { reserve }, generate }).propose({ message: "Water done", consent: true }, await store().today(), member).catch(error => error);
    expect(error).toBeInstanceOf(failure instanceof BudgetExceeded ? BudgetExceeded : ModelUnavailable);
    expect(String(error)).not.toContain("private storage"); expect(error.cause).toBeUndefined();
    expect(reserve).toHaveBeenCalledOnce(); expect(generate).not.toHaveBeenCalled();
  });

  it.each([new Error("private provider prompt"), { action: "delete_everything", text: "private model output" }])("sanitizes provider failures without retrying or refunding quota", async output => {
    const reserve = vi.fn(async () => {}), generate = vi.fn(async () => { if (output instanceof Error) throw output; return output; });
    const error = await createFamilyConversationService({ budget: { reserve }, generate }).propose({ message: "Water done", consent: true }, await store().today(), member).catch(error => error);
    expect(error).toBeInstanceOf(ModelUnavailable); expect(String(error)).not.toContain("private"); expect(error.cause).toBeUndefined();
    expect(reserve).toHaveBeenCalledOnce(); expect(generate).toHaveBeenCalledOnce();
  });

  it("grounds the provider's proposed task in the current open snapshot", async () => {
    const service = createFamilyConversationService({ budget: { reserve: async () => {} }, generate: async () => ({ action: "confirm", taskId: "another-family-task", response: "done" }) });
    expect(await service.propose({ message: "Done", consent: true }, await store().today(), member)).toEqual({ action: "clarify", mode: "bedrock" });
  });

  it("allows a five-second family model deadline while rejecting unbounded timeout configuration", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const generate = createBedrockIntentGenerator({ modelId: "synthetic-model", timeoutMs: 5000,
      client: { send: async () => ({ $metadata: {}, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 },
        output: { message: { role: "assistant", content: [{ text: '{"action":"today"}' }] } } }) } });
    expect(await generate("show today", [])).toEqual({ action: "today" });
    expect(timeout).toHaveBeenCalledWith(5000);
    for (const timeoutMs of [0, -1, 8001, Number.NaN]) expect(() => createBedrockIntentGenerator({ modelId: "synthetic-model", timeoutMs })).toThrow(RangeError);
  });
});
