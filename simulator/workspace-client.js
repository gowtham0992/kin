import { createConfirmationSender } from "./care-client.js";

export function createWorkspaceClient({ request, newRequestId }) {
  let generation = 0;
  let pendingPlan = null;
  async function json(url, options = {}) {
    const revision = generation;
    const response = await request(url, { cache: "no-store", signal: AbortSignal.timeout(8000), ...options });
    if (revision !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
    if (!response.ok) throw Object.assign(new Error("Request failed"), { status: response.status, definitiveRejection: [400, 401, 403, 404, 422].includes(response.status) });
    const data = await response.json();
    if (revision !== generation) throw Object.assign(new Error("Session changed"), { stale: true });
    return data;
  }
  const sender = () => createConfirmationSender({ newRequestId, send: async ({ taskId, ...body }) => {
    const result = await json(`/api/tasks/${encodeURIComponent(taskId)}/confirm`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (result.confirmation?.requestId !== body.requestId || result.confirmation?.taskId !== taskId || result.confirmation?.response !== body.response) throw new Error("Receipt mismatch");
    return result;
  } });
  let confirmations = sender();
  async function savePlan() {
    const current = pendingPlan;
    try {
      const result = await json(current.dueAts ? "/api/routines" : "/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(current) });
      const matches = current.dueAts ? Array.isArray(result.tasks) && result.tasks.length === current.dueAts.length &&
        result.tasks.every((task, index) => task.title === current.title && task.dueAt === current.dueAts[index])
        : result.task?.title === current.title && result.task?.dueAt === current.dueAt;
      if (result.requestId !== current.requestId || !matches) throw new Error("Receipt mismatch");
      pendingPlan = null; return result;
    } catch (error) { if (error.definitiveRejection) pendingPlan = null; throw error; }
  }
  return {
    session: () => json("/api/session"),
    today: () => json("/api/today"),
    plan: () => json("/api/plan"),
    schedule(input) {
      if (pendingPlan && (pendingPlan.title !== input.title || pendingPlan.dueAt !== input.dueAt || pendingPlan.timeZone !== input.timeZone || JSON.stringify(pendingPlan.dueAts) !== JSON.stringify(input.dueAts))) return Promise.reject(new Error("Resolve the pending task first"));
      pendingPlan ??= { ...input, requestId: newRequestId ? newRequestId() : crypto.randomUUID() };
      return savePlan();
    },
    circle: () => json("/api/circle"),
    brief: () => json("/api/weekly-brief"),
    access: () => json("/api/access"),
    acknowledge: id => json(`/api/escalations/${encodeURIComponent(id)}/acknowledge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) }),
    revoke: memberId => json("/api/access/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberId, confirm: true }) }),
    confirm: input => confirmations.confirm(input),
    retry: () => pendingPlan ? savePlan() : confirmations.retry(),
    get pending() { return pendingPlan ?? confirmations.pending; },
    get pendingKind() { return pendingPlan ? "scheduled task" : "check-in"; },
    assignDuty: input => json("/api/circle/duty", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
    reset() { generation += 1; confirmations = sender(); pendingPlan = null; },
  };
}
