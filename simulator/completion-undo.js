// Only a verified completion from this browser session can become an undo offer.
// This is a review/retry coordinator; the backend owns authorization and atomic state.
const fields = ["title", "dueAt", "state", "lastResponse", "confirmedAt", "confirmedBy"];
const review = task => Object.fromEntries(fields.map(key => [key, task?.[key]]));
const same = (left, right) => !!left && !!right && fields.every(key => left[key] === right[key]);
const instant = value => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const name = value => typeof value === "string" && value.length > 0 && value.length <= 80;
const valid = value => value && typeof value.title === "string" && value.title.length > 0 && value.title.length <= 120 && instant(value.dueAt)
  && ["scheduled", "done", "skipped", "cancelled"].includes(value.state)
  && [null, "done", "not_yet", "skipped"].includes(value.lastResponse)
  && (value.confirmedAt === null || instant(value.confirmedAt)) && (value.confirmedBy === null || name(value.confirmedBy));
const conflict = message => Object.assign(new Error(message), { status: 409, definitiveRejection: true });

export function createCompletionUndo({ send, newRequestId = () => crypto.randomUUID(), now = Date.now }) {
  let identity = null, enabled = false, latest = null, reviewedAt = null, pending = null, inFlight = null, generation = 0;
  const fresh = (at, lifetime) => Number.isFinite(at) && at <= now() && now() - at <= lifetime;
  function reset() { generation += 1; identity = null; enabled = false; latest = null; reviewedAt = null; pending = null; inFlight = null; }
  function offer(snapshot) {
    if (!enabled || !latest || !fresh(latest.recordedAt, 300_000)) { latest = null; reviewedAt = null; return null; }
    const task = snapshot?.tasks?.find(value => value.id === latest.taskId);
    if (!same(task, latest.expected)) { latest = null; reviewedAt = null; return null; }
    return structuredClone(latest);
  }
  function attempt() {
    if (inFlight) return inFlight;
    if (!pending) return Promise.reject(new Error("No pending completion undo"));
    const current = generation, input = structuredClone(pending);
    inFlight = Promise.resolve().then(() => {
      if (current !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
      return send(input);
    }).then(result => {
      if (current !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
      const receipt = result?.undo;
      if (!receipt || typeof receipt.id !== "string" || !/^undo_[A-Za-z0-9_-]{8,100}$/.test(receipt.id)
        || receipt.requestId !== input.requestId || receipt.confirmationRequestId !== input.confirmationRequestId
        || receipt.taskId !== input.taskId || receipt.taskDueAt !== input.expected.dueAt || !name(receipt.actor) || !instant(receipt.recordedAt)
        || !valid(receipt.restored) || !valid(result.task) || result.task.id !== input.taskId || typeof result.replayed !== "boolean"
        || !same(receipt.restored, input.restore) || !same(result.task, input.restore)) throw new Error("Receipt mismatch");
      pending = null; latest = null; reviewedAt = null;
      return result;
    }).catch(error => {
      if (current !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
      // Access can change after commit. Retain only until the workspace closes,
      // so its signed-out notice can preserve an opaque uncertain-operation ID.
      if ([401, 403].includes(error.status)) error.outcomeUnknown = true;
      else if ([400, 404, 409, 422].includes(error.status)) { pending = null; latest = null; reviewedAt = null; }
      throw error;
    }).finally(() => { if (current === generation) inFlight = null; });
    return inFlight;
  }
  return {
    reset,
    configure(session) {
      const next = typeof session?.memberId === "string" ? session.memberId : null;
      if (identity !== next) reset();
      identity = next;
      enabled = !!identity && session.permissions?.confirm === true && session.role !== "viewer"
        && session.features?.completionUndo === true && session.features.completionUndoWindowSeconds === 300;
      if (!enabled) { latest = null; reviewedAt = null; }
    },
    record(input, result) {
      latest = null; reviewedAt = null;
      const receipt = result?.confirmation, task = result?.task, before = input.expected;
      if (!enabled || input.response !== "done" || !valid(before) || before.state !== "scheduled"
        || ![null, "not_yet"].includes(before.lastResponse) || !valid(task) || task.state !== "done" || task.lastResponse !== "done"
        || !receipt || receipt.requestId !== input.requestId || receipt.taskId !== input.taskId || task.id !== input.taskId
        || receipt.response !== "done" || receipt.taskDueAt !== task.dueAt || task.dueAt !== before.dueAt || task.title !== before.title
        || task.confirmedAt !== receipt.recordedAt || task.confirmedBy !== receipt.actor || !fresh(Date.parse(receipt.recordedAt), 300_000)
        || !same(result.snapshot?.tasks?.find(value => value.id === task.id), task)) return;
      latest = { taskId: task.id, confirmationRequestId: receipt.requestId, expected: review(task), restore: review(before), recordedAt: Date.parse(receipt.recordedAt) };
    },
    offer,
    prepare(snapshot) {
      if (pending) throw new Error("Resolve the pending completion undo first");
      const value = offer(snapshot);
      if (!value) throw conflict("That completion changed or the five-minute undo window expired. Refresh the current plan.");
      reviewedAt = now(); return value;
    },
    cancelReview() { reviewedAt = null; },
    get reviewing() { return reviewedAt !== null; },
    get pending() { return pending ? structuredClone(pending) : null; },
    confirm() {
      if (pending) return attempt();
      if (!enabled || !latest || reviewedAt === null) return Promise.reject(conflict("Review the completion before undoing it."));
      if (!fresh(latest.recordedAt, 300_000) || !fresh(reviewedAt, 90_000)) {
        reviewedAt = null; return Promise.reject(conflict("That undo review expired. Review the current plan again."));
      }
      pending = { taskId: latest.taskId, confirmationRequestId: latest.confirmationRequestId,
        requestId: newRequestId(), expected: structuredClone(latest.expected), restore: structuredClone(latest.restore), confirm: true };
      return attempt();
    },
    retry: attempt,
  };
}
