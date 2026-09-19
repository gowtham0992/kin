import { afterEach, describe, expect, it, vi } from "vitest";
import { createEchoReminderClient } from "../src/echo-reminders.js";

const endpoint = "https://api.amazonalexa.com", token = "private-token-never-log";
const at = "2026-09-18T01:00:00Z", due = "2026-09-18T02:00:00Z";
afterEach(() => vi.restoreAllMocks());
describe("safe reminder creation diagnostics", () => {
  it.each([400, 401, 403, 429, 500])("records HTTP %s without its private body or a retry", async status => {
    const sink = vi.fn(), fetcher = vi.fn(async () => new Response("private-upstream-body", { status }));
    const client = createEchoReminderClient(fetcher, sink);
    await expect(client.createCheckIn!(endpoint, token, at, due)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toEqual({ version: 1, operation: "create", phase: "request", outcome: "unverified",
      reason: status === 401 || status === 403 ? "permission" : "http", httpStatus: status, elapsedMs: expect.any(Number) });
    expect(JSON.stringify(sink.mock.calls)).not.toMatch(/private|amazonalexa|2026-/);
  });
  it("records network failure without reading the exception", async () => {
    const sink = vi.fn(), fetcher = vi.fn(async () => { throw new Error(token); });
    await expect(createEchoReminderClient(fetcher, sink).createCheckIn!(endpoint, token, at, due)).rejects.toThrow();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ version: 1, operation: "create", phase: "request", outcome: "unverified", reason: "network", elapsedMs: expect.any(Number) });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("distinguishes timeout using the request signal, not error text", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const sink = vi.fn(), fetcher = vi.fn(async () => { throw new Error(token); });
    await expect(createEchoReminderClient(fetcher, sink).createCheckIn!(endpoint, token, at, due)).rejects.toThrow();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ version: 1, operation: "create", phase: "request", outcome: "unverified", reason: "timeout", elapsedMs: expect.any(Number) });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("distinguishes HTTP acceptance with an unreadable receipt", async () => {
    const sink = vi.fn(), fetcher = vi.fn(async () => new Response("private-broken-json", { status: 201 }));
    await expect(createEchoReminderClient(fetcher, sink).createCheckIn!(endpoint, token, at, due)).rejects.toThrow();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ version: 1, operation: "create", phase: "receipt", outcome: "unverified", reason: "receipt", httpStatus: 201, elapsedMs: expect.any(Number) });
  });
  it("records accepted without leaking the receipt token", async () => {
    const sink = vi.fn(), fetcher = vi.fn(async () => Response.json({ alertToken: token }, { status: 201 }));
    await expect(createEchoReminderClient(fetcher, sink).createCheckIn!(endpoint, token, at, due)).resolves.toEqual({ alertToken: token });
    expect(sink).toHaveBeenCalledExactlyOnceWith({ version: 1, operation: "create", phase: "receipt", outcome: "accepted", reason: "none", httpStatus: 201, elapsedMs: expect.any(Number) });
  });
  it("records rejected input without attempting the network", async () => {
    const sink = vi.fn(), fetcher = vi.fn();
    await expect(createEchoReminderClient(fetcher, sink).createTest("https://untrusted.invalid", token, at)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ version: 1, operation: "create", phase: "validation", outcome: "unverified", reason: "input", elapsedMs: expect.any(Number) });
  });
});
