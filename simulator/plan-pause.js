const hour = 3_600_000;
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const ref = task => task && /^[A-Za-z0-9_-]{1,100}$/.test(task.id) && typeof task.title === "string" && task.title.length > 0 && task.title.length <= 120 && instant(task.dueAt);
const sameRef = (a, b) => a === null ? b === null : b && ["id", "title", "dueAt"].every(key => a[key] === b[key]);
export function validPauseProposal(value) {
  if (!value || !instant(value.startsAt) || !instant(value.endsAt) || Date.parse(value.endsAt) - Date.parse(value.startsAt) !== 168 * hour ||
      value.durationHours !== 168 || !instant(value.expiresAt) || Date.parse(value.expiresAt) - Date.parse(value.startsAt) !== 5 * 60_000 ||
      !/^[a-f0-9]{64}$/.test(value.reviewToken) || !Array.isArray(value.tasks) || value.tasks.length > 25 ||
      value.tasks.some(task => !ref(task) || task.dueAt <= value.startsAt || task.dueAt >= value.endsAt) || new Set(value.tasks.map(task => task.id)).size !== value.tasks.length ||
      (value.nextTask !== null && (!ref(value.nextTask) || value.nextTask.dueAt < value.endsAt))) return false;
  try { new Intl.DateTimeFormat(undefined, { timeZone: value.timeZone }).format(); } catch { return false; }
  return typeof value.timeZone === "string" && value.timeZone.length > 0;
}
export function assertPauseReceipt(result, current) {
  const { input, proposal } = current, receipt = result?.receipt, pause = result?.control?.pause;
  if (!receipt || !pause || !Number.isSafeInteger(result.control.version) || result.control.version < 1 || typeof result.replayed !== "boolean" ||
      ["requestId", "startsAt", "endsAt"].some(key => receipt[key] !== input[key] || pause[key] !== input[key]) ||
      !instant(receipt.recordedAt) || receipt.recordedAt < input.startsAt || receipt.recordedAt > proposal.expiresAt ||
      pause.recordedAt !== receipt.recordedAt || typeof receipt.actor !== "string" || !receipt.actor || pause.actor !== receipt.actor || receipt.timeZone !== proposal.timeZone ||
      !Array.isArray(receipt.cancelled) || receipt.cancelled.length !== proposal.tasks.length ||
      receipt.cancelled.some((task, index) => !sameRef(proposal.tasks[index], task)) || !sameRef(proposal.nextTask, receipt.nextTask) ||
      !Array.isArray(result.cancelledTasks) || result.cancelledTasks.length !== proposal.tasks.length ||
      result.cancelledTasks.some((task, index) => !sameRef(proposal.tasks[index], task) || task.state !== "cancelled")) throw new Error("Receipt mismatch");
}
const node = (tag, text, className) => { const element = document.createElement(tag); if (text != null) element.textContent = text; if (className) element.className = className; return element; };
const stamp = (value, timeZone) => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(value));
export const pauseSavedMessage = "The reviewed check-ins were cancelled. New check-ins are blocked during the reviewed seven-day interval. Cancelled check-ins will not return or shift to later dates. Old Alexa reminders may still sound until cancellation sync finishes; queued caregiver alerts are not retracted.";

// A read-only proposal belongs to one rendered view. No care draft is persisted.
export function renderPlanPause({ control, enabled, propose, onSave, isLocked, onError, now = Date.now }) {
  let alive = true, loading = false, expiryTimer = null;
  const element = node("section", null, "invite-panel care-plan-pause"), review = node("div"), message = node("p", "", "care-note");
  message.setAttribute("role", "status"); review.hidden = true;
  element.append(node("h3", "Cancel the next seven days’ check-ins."));
  const active = control?.pause && instant(control.pause.endsAt) && Date.parse(control.pause.endsAt) > now();
  if (active) {
    element.append(node("p", `New check-ins are blocked from ${stamp(control.pause.startsAt)} until ${stamp(control.pause.endsAt)}.`, "care-pause-active"),
      node("p", "Cancelled check-ins stay in history. They will not catch up or extend the routine. Already-due or answered check-ins remain unchanged. Old Alexa reminders may still sound until cancellation sync finishes; queued caregiver alerts are not retracted.", "care-note"));
  } else if (control?.pause) element.append(node("p", `The previous cancellation interval ended ${stamp(control.pause.endsAt)}. Cancelled check-ins were not restored.`, "care-note"));
  const start = node("button", "Review seven-day cancellation", "secondary"); start.type = "button";
  if (enabled && !active) element.append(node("p", "Cancel future, unanswered check-ins in the next 168 hours and block new check-ins in that interval. This is not a reversible pause. Review the times and affected check-ins before saving."), start, message, review);
  else if (!active) element.append(node("p", "Seven-day cancellation is not available for this account right now.", "care-note"));
  start.addEventListener("click", async () => {
    if (!alive || loading || isLocked() || !enabled || active) return;
    clearTimeout(expiryTimer); loading = true; start.disabled = true; review.hidden = true;
    message.textContent = "Preparing the exact week and check-ins…";
    try {
      const data = await propose(); if (!alive || isLocked()) return;
      if (data.proposal === null) { message.textContent = "A cancellation interval is already active. Refresh to see its dates."; return; }
      const proposal = data.proposal;
      if (!validPauseProposal(proposal) || Date.parse(proposal.expiresAt) <= now()) throw new Error("Pause review unavailable");
      const heading = node("h4", "Review this cancellation"); heading.setAttribute("tabindex", "-1");
      const dates = node("p", `${stamp(proposal.startsAt, proposal.timeZone)} through ${stamp(proposal.endsAt, proposal.timeZone)} · ${proposal.timeZone} · exactly 168 hours.`);
      const list = node("ul");
      for (const task of proposal.tasks) list.append(node("li", `${task.title} · ${stamp(task.dueAt, proposal.timeZone)}`));
      const count = node("p", proposal.tasks.length ? `${proposal.tasks.length} future unanswered check-in${proposal.tasks.length === 1 ? "" : "s"} will be cancelled:` : "No existing check-ins will be cancelled. New check-ins are still blocked during the reviewed interval.");
      const next = node("p", proposal.nextTask ? `Next remaining unanswered check-in: ${proposal.nextTask.title} · ${stamp(proposal.nextTask.dueAt, proposal.timeZone)}.` : "No unanswered check-in remains after this interval in the next 30-day plan.");
      const consentLabel = node("label", null, "consent-line"), consent = node("input"); consent.type = "checkbox"; consent.required = true;
      consentLabel.append(consent, node("span", "I reviewed these exact dates and check-ins. Cancelled occurrences will not be restored or moved later."));
      const save = node("button", "Confirm seven-day cancellation", "primary"); save.type = "button";
      const cancel = node("button", "Keep the plan unchanged", "secondary"); cancel.type = "button";
      const expire = () => { if (!alive) return; consent.checked = false; save.disabled = true; message.textContent = "This review expired. Review a fresh week before confirming."; };
      expiryTimer = setTimeout(expire, Math.max(1, Date.parse(proposal.expiresAt) - now()));
      save.addEventListener("click", () => {
        if (!alive || isLocked() || !consent.checked || save.disabled) return;
        consent.checked = false;
        if (Date.parse(proposal.expiresAt) <= now()) { expire(); return; }
        void onSave(structuredClone(proposal));
      });
      cancel.addEventListener("click", () => { if (!alive || isLocked()) return; clearTimeout(expiryTimer); review.replaceChildren(); review.hidden = true; message.textContent = "The plan is unchanged."; start.focus(); });
      const actions = node("div", null, "care-actions"); actions.append(save, cancel);
      review.replaceChildren(heading, dates, count, list, next,
        node("p", "Already-due and answered check-ins stay unchanged. Later routine dates do not move; nothing catches up or renews. Old Alexa reminders may still sound until cancellation sync finishes. This does not retract queued caregiver alerts or create reminders.", "care-note"), consentLabel, actions);
      review.hidden = false; heading.focus(); message.textContent = "Nothing has changed yet. Confirm only after reviewing the list.";
    } catch (error) {
      if (!alive) return;
      message.textContent = error.status === 409 ? "The check-ins cannot be cancelled as reviewed. Refresh and try a new review; at most 25 check-ins can be cancelled together."
        : error.status === 404 ? "Seven-day cancellation is not enabled right now. The plan is unchanged." : "Could not prepare a cancellation. Check your connection and try again.";
      if ([401, 403].includes(error.status)) onError(error);
    } finally { loading = false; if (alive) start.disabled = isLocked(); }
  });
  return { element, get loading() { return loading; }, destroy() { alive = false; clearTimeout(expiryTimer); review.replaceChildren(); } };
}
