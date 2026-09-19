import { createConfirmationSender } from "./care-client.js";
import { createCompletionUndo } from "./completion-undo.js";
import { validPauseProposal, assertPauseReceipt } from "./plan-pause.js";

// Session memory only. Never persist care drafts or reuse them across identities.
export function createPlanDraft() {
  let value = { title: "", due: "", repeat: "1" };
  return {
    read: () => ({ ...value }),
    update(input) { value = { title: String(input.title ?? "").slice(0, 120), due: String(input.due ?? "").slice(0, 30), repeat: ["1", "7", "14"].includes(input.repeat) ? input.repeat : "1" }; },
    clear() { value = { title: "", due: "", repeat: "1" }; },
  };
}

// Materialize the whole server-defined week, including days without a stored duty row.
export function dutyDays(circle) {
  const first = new Date(`${circle.startDate}T12:00:00Z`);
  if (Number.isNaN(first.getTime()) || first.toISOString().slice(0, 10) !== circle.startDate) throw new Error("Invalid coverage window");
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(first); day.setUTCDate(day.getUTCDate() + index);
    const date = day.toISOString().slice(0, 10);
    return { date, assignment: circle.assignments.find(assignment => assignment.date === date) ?? null };
  });
  if (days[6].date !== circle.endDate) throw new Error("Invalid coverage window");
  return days;
}

export function createWorkspaceClient({ request, newRequestId, mcp, now }) {
  let generation = 0;
  let pendingPlan = null;
  let pendingDuty = null;
  let pendingRoster = null;
  let pendingRotation = null;
  let pendingPause = null;
  const pauseConflict = () => Promise.reject(new Error("Resolve the pending plan pause first"));
  const undo = createCompletionUndo({ newRequestId, now, send: ({ taskId, ...body }) => json(`/api/tasks/${encodeURIComponent(taskId)}/undo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) });
  const undoLocked = () => undo.reviewing || !!undo.pending;
  const undoConflict = () => Promise.reject(new Error("Resolve the completion undo first"));
  async function json(url, options = {}) {
    const revision = generation;
    const response = await request(url, { cache: "no-store", signal: AbortSignal.timeout(8000), ...options });
    if (revision !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
    if (!response.ok) throw Object.assign(new Error("Request failed"), { status: response.status, definitiveRejection: [400, 401, 403, 404, 422].includes(response.status) || (response.status === 409 && /\/confirm$/.test(url)) });
    const data = await response.json();
    if (revision !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
    return data;
  }
  async function mcpCall(action) {
    const current = generation;
    if (!mcp) throw new Error("Authenticated MCP is unavailable");
    const connection = await mcp();
    if (current !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
    const result = await action(connection);
    if (current !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
    return result;
  }
  async function interpret(message, transfer, selectedTaskId) {
    // Explicit selection belongs only to the exact-command path, never model context.
    const selected = transfer ? undefined : selectedTaskId;
    const result = await json("/api/conversation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message,
      ...(selected ? { selectedTaskId: selected } : {}),
      ...(transfer ? { mode: "bedrock", transferConsent: transfer.consent === true, disclosureVersion: transfer.version } : {}) }) });
    if (selected && result.action === "confirm" && result.task?.id !== selected) {
      throw Object.assign(new Error("The selected check-in changed"), { status: 409, definitiveRejection: true });
    }
    return result;
  }
  const sender = () => {
    const ownerGeneration = generation;
    return createConfirmationSender({ newRequestId, send: async ({ taskId, viaMcp, ...body }) => {
      // The sender can run in a later microtask. Bind it before enqueueing, not after a reset.
      if (ownerGeneration !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
      const result = viaMcp ? await mcpCall(connection => connection.confirm({ ...body, taskId })) : await json(`/api/tasks/${encodeURIComponent(taskId)}/confirm`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (result.confirmation?.requestId !== body.requestId || result.confirmation?.taskId !== taskId || result.confirmation?.response !== body.response) throw new Error("Receipt mismatch");
      undo.record({ ...body, taskId }, result);
      return result;
    } });
  };
  let confirmations = sender();
  async function savePause() {
    const current = pendingPause;
    try {
      const result = await json("/api/plan/pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(current.input) });
      assertPauseReceipt(result, current); pendingPause = null; return result;
    } catch (error) {
      if ([401, 403].includes(error.status) && current.uncertain) error.outcomeUnknown = true;
      else if (error.definitiveRejection || error.status === 409) pendingPause = null;
      else if (!error.stale) current.uncertain = true;
      throw error;
    }
  }
  async function saveRotation() {
    const current = pendingRotation;
    try {
      const result = await json("/api/circle/rotation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(current) });
      const end = new Date(`${current.startDate}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 6);
      if (result.requestId !== current.requestId || result.startDate !== current.startDate || result.endDate !== end.toISOString().slice(0, 10) ||
        !Number.isInteger(result.assigned) || result.assigned < 0 || result.assigned > 7 || !Array.isArray(result.assignments) ||
        result.assignments.length < result.assigned || result.assignments.length > 7 || new Set(result.assignments.map(day => day.date)).size !== result.assignments.length ||
        result.assignments.some(day => typeof day.date !== "string" || day.date < current.startDate || day.date > result.endDate || typeof day.memberId !== "string")) throw new Error("Receipt mismatch");
      pendingRotation = null; return result;
    } catch (error) { if (error.definitiveRejection || error.status === 409) pendingRotation = null; throw error; }
  }
  async function saveRoster() {
    const current = pendingRoster;
    try {
      const result = await json("/api/circle/people", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(current) });
      const person = result.person;
      if (result.requestId !== current.requestId || result.action !== current.action || person?.name !== current.name ||
          (current.action === "enable_duty" ? person?.id !== current.memberId || person.canReceiveAlerts !== true || person.canRename !== false || person.relationship === "parent" : current.action === "connect_self" ? !/^[A-Za-z0-9_-]{1,80}$/.test(person?.id ?? "") || person.id === current.memberId || person.canReceiveAlerts !== true || person.canRename !== false || person.relationship !== "caregiver" : current.action === "rename" ? person?.id !== current.memberId :
            !/^person-[a-f0-9]{40}$/.test(person?.id ?? "") || person?.relationship !== current.relationship || person?.canReceiveAlerts !== false)) throw new Error("Receipt mismatch");
      pendingRoster = null; return result;
    } catch (error) { if (error.definitiveRejection || error.status === 409) pendingRoster = null; throw error; }
  }
  async function saveDuty() {
    const current = pendingDuty;
    try {
      const result = await json("/api/circle/duty", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(current) });
      if (result.requestId !== current.requestId || !Array.isArray(result.assignments) || (current.memberId === null
        ? result.assignments.some(day => day.date === current.date)
        : !result.assignments.some(day => day.date === current.date && day.memberId === current.memberId))) throw new Error("Receipt mismatch");
      pendingDuty = null; return result;
    } catch (error) { if (error.definitiveRejection || error.status === 409) pendingDuty = null; throw error; }
  }
  async function savePlan() {
    const current = pendingPlan;
    try {
      const { routineId, taskId, ...body } = current;
      const result = await json(taskId ? `/api/tasks/${encodeURIComponent(taskId)}/change` : routineId ? `/api/routines/${encodeURIComponent(routineId)}/change` : current.dueAts ? "/api/routines" : "/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (taskId) {
        if (result.requestId !== current.requestId || result.taskId !== taskId || result.action !== current.action || result.changed !== 1) throw new Error("Receipt mismatch");
        if (current.action === "reschedule" ? !/^care-[a-f0-9]{40}$/.test(result.replacement?.taskId) || result.replacement.taskId === taskId || result.replacement.dueAt !== current.dueAt
          : result.replacement !== undefined) throw new Error("Receipt mismatch");
        pendingPlan = null; return result;
      }
      if (routineId) {
        if (result.requestId !== current.requestId || result.changed !== current.expected.length) throw new Error("Receipt mismatch");
        pendingPlan = null; return result;
      }
      const matches = current.dueAts ? Array.isArray(result.tasks) && result.tasks.length === current.dueAts.length &&
        result.tasks.every((task, index) => task.title === current.title && task.dueAt === current.dueAts[index])
        : result.task?.title === current.title && result.task?.dueAt === current.dueAt;
      if (result.requestId !== current.requestId || !matches) throw new Error("Receipt mismatch");
      pendingPlan = null; return result;
    } catch (error) { if (error.definitiveRejection || ((current.routineId || current.taskId) && error.status === 409)) pendingPlan = null; throw error; }
  }
  return {
    async session() { const session = await json("/api/session"); undo.configure(session); return session; },
    undoOffer: snapshot => undo.offer(snapshot),
    get undoReviewing() { return undo.reviewing; },
    cancelUndoReview: () => undo.cancelReview(),
    async prepareUndo() {
      if (pendingPause) return pauseConflict();
      if (pendingRotation || pendingRoster || pendingDuty || pendingPlan || confirmations.pending || undo.pending) throw new Error("Resolve the pending change first");
      const session = await json("/api/session"); undo.configure(session);
      return undo.prepare(await json("/api/today"));
    },
    undoCompletion() {
      if (pendingPause) return pauseConflict();
      if (pendingRotation || pendingRoster || pendingDuty || pendingPlan || confirmations.pending) return Promise.reject(new Error("Resolve the pending change first"));
      return undo.confirm();
    },
    today: () => json("/api/today"),
    interpret,
    async interpretMcp(message, transfer, selectedTaskId) {
      const current = generation;
      const snapshot = await mcpCall(connection => connection.today());
      if (current !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
      const result = await interpret(message, transfer, selectedTaskId);
      if (result.action === "confirm") {
        const task = snapshot.tasks?.find(task => task.id === result.task?.id);
        if (!task || !result.expected || ["title", "dueAt", "state", "lastResponse", "confirmedAt", "confirmedBy"].some(key => task[key] !== result.expected[key])) {
          throw Object.assign(new Error("The reviewed task changed"), { status: 409, definitiveRejection: true });
        }
      }
      if (result.action === "brief") return { ...result, brief: await mcpCall(connection => connection.brief()) };
      return result.action === "today" ? { ...result, snapshot } : result;
    },
    plan: () => json("/api/plan"),
    proposePlanPause: () => json("/api/plan/pause"),
    pausePlan(proposal) {
      if (undoLocked()) return undoConflict();
      if (pendingPause || pendingRotation || pendingRoster || pendingDuty || pendingPlan || confirmations.pending) return Promise.reject(new Error("Resolve the pending change first"));
      if (!validPauseProposal(proposal)) return Promise.reject(new Error("Invalid pause review"));
      pendingPause = { proposal: structuredClone(proposal), input: { startsAt: proposal.startsAt, endsAt: proposal.endsAt, reviewToken: proposal.reviewToken,
        requestId: newRequestId ? newRequestId() : crypto.randomUUID(), confirm: true } };
      return savePause();
    },
    schedule(input) {
      if (pendingPause) return pauseConflict();
      if (undoLocked()) return undoConflict();
      if (pendingRotation) return Promise.reject(new Error("Resolve the pending rotation first"));
      if (pendingRoster) return Promise.reject(new Error("Resolve the pending circle change first"));
      if (pendingPlan && (pendingPlan.title !== input.title || pendingPlan.dueAt !== input.dueAt || pendingPlan.timeZone !== input.timeZone || JSON.stringify(pendingPlan.dueAts) !== JSON.stringify(input.dueAts))) return Promise.reject(new Error("Resolve the pending task first"));
      pendingPlan ??= { ...input, requestId: newRequestId ? newRequestId() : crypto.randomUUID() };
      return savePlan();
    },
    changeRoutine(input) {
      if (pendingPause) return pauseConflict();
      if (undoLocked()) return undoConflict();
      if (pendingRotation) return Promise.reject(new Error("Resolve the pending rotation first"));
      if (pendingPlan || pendingRoster) return Promise.reject(new Error("Resolve the pending task first"));
      pendingPlan = { ...input, requestId: newRequestId ? newRequestId() : crypto.randomUUID() };
      return savePlan();
    },
    changeTask(input) {
      if (pendingPause) return pauseConflict();
      if (undoLocked()) return undoConflict();
      if (pendingRotation) return Promise.reject(new Error("Resolve the pending rotation first"));
      if (pendingPlan || pendingRoster || pendingDuty || confirmations.pending) return Promise.reject(new Error("Resolve the pending change first"));
      pendingPlan = { ...structuredClone(input), requestId: newRequestId ? newRequestId() : crypto.randomUUID() };
      return savePlan();
    },
    circle: () => json("/api/circle"),
    proposeDutyRotation: () => json("/api/circle/rotation"),
    acceptDutyRotation(input) {
      if (pendingPause) return pauseConflict();
      if (undoLocked()) return undoConflict();
      if (pendingRotation || pendingRoster || pendingDuty || pendingPlan || confirmations.pending) return Promise.reject(new Error("Resolve the pending change first"));
      pendingRotation = { startDate: input.startDate, reviewToken: input.reviewToken, confirm: true,
        requestId: newRequestId ? newRequestId() : crypto.randomUUID() };
      return saveRotation();
    },
    roster: () => json("/api/circle/people"),
    changeRoster(input) {
      if (pendingPause) return pauseConflict();
      if (undoLocked()) return undoConflict();
      if (pendingRotation) return Promise.reject(new Error("Resolve the pending rotation first"));
      if (pendingRoster || pendingDuty || pendingPlan || confirmations.pending) return Promise.reject(new Error("Resolve the pending change first"));
      pendingRoster = { ...structuredClone(input), name: input.name.trim(), requestId: newRequestId ? newRequestId() : crypto.randomUUID() };
      return saveRoster();
    },
    brief: () => json("/api/weekly-brief"),
    access: () => json("/api/access"),
    acknowledge: id => pendingPause ? pauseConflict() : undoLocked() ? undoConflict() : pendingRotation ? Promise.reject(new Error("Resolve the pending rotation first")) : json(`/api/escalations/${encodeURIComponent(id)}/acknowledge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) }),
    revoke: memberId => pendingPause ? pauseConflict() : undoLocked() ? undoConflict() : pendingRotation ? Promise.reject(new Error("Resolve the pending rotation first")) : json("/api/access/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberId, confirm: true }) }),
    confirm: input => pendingPause ? pauseConflict() : undoLocked() ? undoConflict() : pendingRoster || pendingRotation || confirmations.pending?.viaMcp ? Promise.reject(new Error("Resolve the pending circle change first")) : confirmations.confirm(input),
    confirmViaMcp: input => pendingPause ? pauseConflict() : undoLocked() ? undoConflict() : pendingRoster || pendingRotation || (confirmations.pending && !confirmations.pending.viaMcp)
      ? Promise.reject(new Error("Resolve the pending change first")) : confirmations.confirm({ ...input, viaMcp: true }),
    retry: () => pendingPause ? savePause() : undo.pending ? undo.retry() : pendingRotation ? saveRotation() : pendingRoster ? saveRoster() : pendingDuty ? saveDuty() : pendingPlan ? savePlan() : confirmations.retry(),
    get pending() { return pendingPause ? structuredClone(pendingPause.input) : undo.pending ?? (pendingRotation ? structuredClone(pendingRotation) : pendingRoster ? structuredClone(pendingRoster) : pendingDuty ?? pendingPlan ?? confirmations.pending); },
    get pendingKind() { return pendingPause ? "plan pause" : undo.pending ? "completion undo" : pendingRotation ? "weekly rotation" : pendingRoster ? "circle change" : pendingDuty ? "duty handoff" : pendingPlan?.taskId ? "check-in change" : pendingPlan?.routineId ? "routine change" : pendingPlan ? "care plan" : "check-in"; },
    assignDuty(input) {
      if (pendingPause) return pauseConflict();
      if (undoLocked()) return undoConflict();
      if (pendingRotation) return Promise.reject(new Error("Resolve the pending rotation first"));
      if (pendingRoster || pendingPlan || confirmations.pending || (pendingDuty && ["date", "memberId", "expectedMemberId"].some(key => pendingDuty[key] !== input[key]))) return Promise.reject(new Error("Resolve the pending change first"));
      pendingDuty ??= { date: input.date, memberId: input.memberId, expectedMemberId: input.expectedMemberId, requestId: newRequestId ? newRequestId() : crypto.randomUUID() };
      return saveDuty();
    },
    reset() { generation += 1; undo.reset(); confirmations = sender(); pendingPlan = null; pendingDuty = null; pendingRoster = null; pendingRotation = null; pendingPause = null; },
  };
}
