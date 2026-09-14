const phases = ["audience", "jwt", "jwks", "membership", "server_setup", "server_connect", "request_handle"] as const;
export type McpInitializePhase = typeof phases[number];
export interface McpInitializeTimingRecord {
  readonly event: "kin_mcp_initialize_timing";
  readonly version: 1;
  /** HTTP handler completion, not proof that a client received the response. */
  readonly outcome: "success" | "failure";
  readonly elapsedMs: number;
  /** JWT time includes JWKS key resolution; these fields are not additive. */
  readonly phases: Readonly<Partial<Record<McpInitializePhase, number>>>;
  readonly httpStatus?: number;
}
export type McpInitializeTimingSink = (record: McpInitializeTimingRecord) => unknown;
export interface McpInitializeTiming {
  start(phase: McpInitializePhase): () => void;
  finish(outcome: "success" | "failure", httpStatus?: number): void;
}

const bounded = (value: number) => Number.isFinite(value) ? Math.min(60_000, Math.max(0, Math.floor(value))) : 0;
const log: McpInitializeTimingSink = record => console.info(JSON.stringify(record));

/** Request-local measurements only. This API accepts no request or error data. */
export function createMcpInitializeTiming(
  sink: McpInitializeTimingSink = log,
  now: () => number = () => performance.now(),
): McpInitializeTiming {
  const clock = () => { try { return now(); } catch { return 0; } };
  const started = clock(), durations: Partial<Record<McpInitializePhase, number>> = {};
  let finished = false;
  return {
    start(phase) {
      if (finished || !phases.includes(phase)) return () => {};
      const from = clock();
      let ended = false;
      return () => {
        if (ended || finished) return;
        ended = true;
        durations[phase] = bounded((durations[phase] ?? 0) + bounded(clock() - from));
      };
    },
    finish(outcome, httpStatus) {
      if (finished) return;
      finished = true;
      // Reconstruct from allowlisted primitives, never spread caller objects.
      const measured: Partial<Record<McpInitializePhase, number>> = {};
      for (const phase of phases) if (durations[phase] !== undefined) measured[phase] = bounded(durations[phase]);
      const record: McpInitializeTimingRecord = Object.freeze({
        event: "kin_mcp_initialize_timing", version: 1,
        outcome: outcome === "success" ? "success" : "failure",
        elapsedMs: bounded(clock() - started), phases: Object.freeze(measured),
        ...(Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? { httpStatus } : {}),
      });
      try { void Promise.resolve(sink(record)).catch(() => {}); } catch { /* Observation cannot change the request. */ }
    },
  };
}

/** Even a supplied observer cannot alter authorization results or exceptions. */
export function startMcpTiming(timing: McpInitializeTiming | undefined, phase: McpInitializePhase): () => void {
  try {
    const end = timing?.start(phase);
    return () => { try { end?.(); } catch { /* Preserve the observed operation. */ } };
  } catch { return () => {}; }
}
