import { BedrockRuntimeClient, type ConverseCommand, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BedrockBriefGenerator, createBedrockBriefGenerator, type WeeklyBriefSource } from "../src/weekly-brief.js";

const source: WeeklyBriefSource = {
  period: { startDate: "2026-09-08", endDate: "2026-09-14" },
  stats: { scheduled: 1, completed: 0, skipped: 0, stillOpen: 1, escalations: 0 },
  evidence: [{ id: "task:synthetic", kind: "care_task", occurredAt: "2026-09-14T15:00:00.000Z", fact: "Water was still open." }],
};
const response = (): ConverseCommandOutput => ({ $metadata: {}, stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 }, output: { message: {
  role: "assistant", content: [{ text: JSON.stringify({ overviewEvidenceIds: ["task:synthetic"], highlightEvidenceIds: ["task:synthetic"], followUps: [] }) }],
} } });

function deferred() {
  let resolve!: (value: ConverseCommandOutput) => void, reject!: (reason: Error) => void;
  const promise = new Promise<ConverseCommandOutput>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function observe<T>(promise: Promise<T>) {
  const result: { state: "pending" | "resolved" | "rejected"; value?: T; error?: Error } = { state: "pending" };
  const settled = promise.then(value => { result.state = "resolved"; result.value = value; }, error => {
    result.state = "rejected"; result.error = error;
  });
  return { result, settled };
}

describe("weekly generator hard deadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("rejects at the default 300 ms even when the sender never settles or observes abort", async () => {
    const pending = deferred(); let signal: AbortSignal | undefined;
    const generator = new BedrockBriefGenerator({ modelId: "synthetic-model", client: {
      send: (_command, options) => { signal = options?.abortSignal; return pending.promise; },
    } });
    const observed = observe(generator.generate(source));
    await vi.advanceTimersByTimeAsync(299);
    expect(observed.result.state).toBe("pending"); expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(observed.result.state).toBe("rejected"); expect(observed.result.error?.message).toMatch(/aborted.*deadline/);
    expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a cooperative sender and returns the deadline error at the configured budget", async () => {
    const aborted = vi.fn();
    const generator = new BedrockBriefGenerator({ modelId: "synthetic-model", timeoutMs: 50, client: {
      send: (_command, options) => new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener("abort", () => { aborted(); reject(new Error("Synthetic SDK cancellation")); }, { once: true });
      }),
    } });
    const observed = observe(generator.generate(source));
    await vi.advanceTimersByTimeAsync(50);
    expect(observed.result.state).toBe("rejected"); expect(observed.result.error?.message).toMatch(/aborted.*deadline/);
    expect(aborted).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept a sender that resolves successfully in response to abort", async () => {
    const generator = new BedrockBriefGenerator({ modelId: "synthetic-model", timeoutMs: 50, client: {
      send: (_command, options) => new Promise(resolve => {
        options?.abortSignal?.addEventListener("abort", () => resolve(response()), { once: true });
      }),
    } });
    const observed = observe(generator.generate(source));
    await vi.advanceTimersByTimeAsync(50);
    expect(observed.result.state).toBe("rejected"); expect(observed.result.value).toBeUndefined();
  });

  it.each(["resolve", "reject"] as const)("discards a late sender %s without changing the settled result", async kind => {
    const pending = deferred(); const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const generator = new BedrockBriefGenerator({ modelId: "synthetic-model", timeoutMs: 50, client: { send: () => pending.promise } });
      const observed = observe(generator.generate(source));
      await vi.advanceTimersByTimeAsync(50);
      expect(observed.result.state).toBe("rejected");
      const deadlineError = observed.result.error;
      if (kind === "resolve") pending.resolve(response()); else pending.reject(new Error("Synthetic late rejection"));
      await vi.advanceTimersByTimeAsync(0);
      await observed.settled;
      expect(observed.result.error).toBe(deadlineError); expect(observed.result.value).toBeUndefined();
      expect(unhandled).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it("clears its deadline after success without aborting the completed request", async () => {
    const pending = deferred(); let signal: AbortSignal | undefined;
    const generator = new BedrockBriefGenerator({ modelId: "synthetic-model", timeoutMs: 100, client: {
      send: (_command, options) => { signal = options?.abortSignal; return pending.promise; },
    } });
    const result = generator.generate(source);
    await vi.advanceTimersByTimeAsync(40); pending.resolve(response());
    expect((await result).generation.provider).toBe("bedrock"); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200); expect(signal?.aborted).toBe(false);
  });

  it.each(["synchronous", "asynchronous"])("clears its timer on %s sender failure", async kind => {
    const failure = new Error("Synthetic sender failed");
    const generator = new BedrockBriefGenerator({ modelId: "synthetic-model", timeoutMs: 50, client: {
      send: () => { if (kind === "synchronous") throw failure; return Promise.reject(failure); },
    } });
    await expect(generator.generate(source)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps separate budgets for overlapping short and long generation requests", async () => {
    const signals: AbortSignal[] = [];
    const send = (_command: ConverseCommand, options?: { abortSignal?: AbortSignal }) => {
      signals.push(options!.abortSignal!); return deferred().promise;
    };
    const short = new BedrockBriefGenerator({ modelId: "synthetic-model", timeoutMs: 50, client: { send } });
    const long = new BedrockBriefGenerator({ modelId: "synthetic-model", timeoutMs: 200, client: { send } });
    const first = observe(short.generate(source));
    await vi.advanceTimersByTimeAsync(20);
    const second = observe(long.generate(source));
    await vi.advanceTimersByTimeAsync(30);
    expect(first.result.state).toBe("rejected"); expect(second.result.state).toBe("pending");
    expect(signals.map(signal => signal.aborted)).toEqual([true, false]); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(169); expect(second.result.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1); expect(second.result.state).toBe("rejected");
    expect(signals.map(signal => signal.aborted)).toEqual([true, true]); expect(vi.getTimerCount()).toBe(0);
  });

  it("configures one SDK attempt for the factory-created weekly client", async () => {
    let attempts: Promise<number> | undefined;
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation(function (this: BedrockRuntimeClient) {
      attempts = this.config.maxAttempts(); return Promise.resolve(response());
    });
    await createBedrockBriefGenerator({ modelId: "synthetic-model", region: "us-east-1" }).generate(source);
    expect(await attempts).toBe(1);
  });
});
