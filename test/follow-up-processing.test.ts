import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetParameterCommand } from "@aws-sdk/client-ssm";
import request from "supertest";
import { createFollowUpProcessingProvider, followUpProcessing } from "../src/follow-up-processing.js";
import { createHttpApp } from "../src/http.js";
import { createDemoStore } from "../src/domain.js";
import { FollowUpWindowIncompleteError } from "../src/dynamo-care-repository.js";

afterEach(() => vi.useRealTimers());
describe("automatic follow-up configuration is not delivery proof", () => {
  it.each([["false", "false", "off"], ["false", "true", "off"], ["true", "false", "off"], ["true", "true", "configured"]])(
    "represents worker %s and schedule %s as %s", async (worker, schedule, state) => {
      const send = vi.fn(async (_command: GetParameterCommand) => ({ Parameter: { Value: JSON.stringify({ version: 1, worker, schedule }) } }));
      const provider = createFollowUpProcessingProvider({ parameterName: "/kin/test-status", client: { send }, now: () => new Date("2026-10-02T12:00:00Z") });
      expect(await provider()).toEqual({ state, checkedAt: "2026-10-02T12:00:00.000Z", source: "deployment_configuration" });
      expect(send.mock.calls[0]?.[0].input).toEqual({ Name: "/kin/test-status" });
    });
  it.each([null, {}, { version: 2, worker: "true", schedule: "true" }, { version: 1, worker: true, schedule: true }])("does not infer enabled from malformed configuration %j", async value => {
    const provider = createFollowUpProcessingProvider({ parameterName: "/kin/test-status", client: { send: async () => ({ Parameter: { Value: JSON.stringify(value) } }) } });
    expect(await provider()).toEqual({ state: "unknown" });
  });
  it("does not reuse stale enabled configuration after an expired cache and failed read", async () => {
    let now = new Date("2026-10-02T12:00:00Z");
    const send = vi.fn().mockResolvedValueOnce({ Parameter: { Value: '{"version":1,"worker":"true","schedule":"true"}' } }).mockRejectedValue(new Error("PRIVATE"));
    const provider = createFollowUpProcessingProvider({ parameterName: "/kin/test-status", client: { send }, now: () => now });
    expect((await provider()).state).toBe("configured");
    now = new Date(now.getTime() + 14_999); expect((await provider()).state).toBe("configured"); expect(send).toHaveBeenCalledOnce();
    now = new Date(now.getTime() + 1); expect(await provider()).toEqual({ state: "unknown" }); expect(send).toHaveBeenCalledTimes(2);
  });
  it("bounds a stalled credential read without starting overlapping requests", async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => new Promise<never>(() => {}));
    const provider = createFollowUpProcessingProvider({ parameterName: "/kin/test-status", client: { send } });
    const first = provider(); await vi.advanceTimersByTimeAsync(800); expect(await first).toEqual({ state: "unknown" });
    const second = provider(); await vi.advanceTimersByTimeAsync(800); expect(await second).toEqual({ state: "unknown" });
    expect(send).toHaveBeenCalledOnce();
  });
  it("defaults absent or failed status to unknown", async () => {
    expect(await followUpProcessing()).toEqual({ state: "unknown" });
    expect(await followUpProcessing(async () => { throw new Error("PRIVATE"); })).toEqual({ state: "unknown" });
  });
  it("recovers on the next read after a synchronous client failure", async () => {
    const send = vi.fn().mockImplementationOnce(() => { throw new Error("PRIVATE"); })
      .mockResolvedValueOnce({ Parameter: { Value: '{"version":1,"worker":"false","schedule":"false"}' } });
    const provider = createFollowUpProcessingProvider({ parameterName: "/kin/test-status", client: { send } });
    expect(await provider()).toEqual({ state: "unknown" });
    expect((await provider()).state).toBe("off");
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("publishes off separately from care state without writing anything", async () => {
    const store = createDemoStore(() => new Date("2026-09-02T08:00:00Z"));
    const before = await store.today();
    const app = createHttpApp(store, undefined, { automaticFollowUps: async () => ({ state: "off" }) });
    const response = await request(app).get("/api/today").expect(200);
    expect(response.body).toEqual({ ...before, automaticFollowUps: { state: "off" } });
    expect(await store.today()).toEqual(before);
    expect((await request(app).get("/api/plan").expect(200)).body.automaticFollowUps).toEqual({ state: "off" });
  });
  it("returns an explicit incomplete state instead of an empty follow-up list", async () => {
    const store = createDemoStore(); vi.spyOn(store, "today").mockRejectedValue(new FollowUpWindowIncompleteError());
    const result = await request(createHttpApp(store)).get("/api/today").expect(503);
    expect(result.body).toEqual({ error: "follow_up_window_incomplete" });
    expect(result.headers["cache-control"]).toBe("no-store");
  });
});
