import { createWorkspaceClient } from "./workspace-client.js";

const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const element = document.createElement(tag); if (text != null) element.textContent = text; if (className) element.className = className; return element; };
const date = value => new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const time = value => new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function createWorkspace({ request, onAccessLost, onInvite, onLeaveInvite }) {
  const client = createWorkspaceClient({ request });
  let member = null, revision = 0, busy = false, loading = false, timer = null, lastRender = "", activeView = "today";
  const content = $("workspace-content"), status = $("workspace-status");
  const tab = () => ["today", "plan", "circle", "week", "invite", "access"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "today";
  function reset() {
    revision += 1; client.reset(); member = null; busy = false; loading = false;
    clearTimeout(timer); content.replaceChildren(); $("workspace").hidden = true;
    $("workspace-nav").hidden = true; $("workspace-identity").textContent = "";
    $("workspace-retry-write").hidden = true;
    document.querySelector("main").classList.remove("workspace-ready"); lastRender = "";
  }
  function failure(error) {
    if (error.stale) return;
    if ([401, 403].includes(error.status)) { reset(); onAccessLost(error.status); return; }
    status.textContent = "Could not refresh. Any visible information is the last known update. Check your connection and try again.";
  }
  function button(label, action, secondary = true) {
    const element = node("button", label, secondary ? "secondary" : "primary"); element.type = "button";
    element.addEventListener("click", action); return element;
  }
  async function mutate(action, success) {
    if (busy) return;
    const current = ++revision; busy = true; loading = false;
    content.querySelectorAll("button, select").forEach(element => { element.disabled = true; });
    status.textContent = "Saving…";
    try { await action(); if (current !== revision) return; status.textContent = success; await refresh(true); }
    catch (error) {
      if (current !== revision) return;
      failure(error);
      if (![401, 403].includes(error.status)) status.textContent = client.pending
        ? `Kin has not acknowledged this ${client.pendingKind}. Retry the same request below; do not submit a different one yet.`
        : "The change was not acknowledged. Refresh to check the current state before trying again.";
      if (error.status === 409 && !client.pending) status.textContent = "The routine changed while you were reviewing it. Refresh, then review the remaining check-ins again.";
    } finally {
      if (current === revision) {
        busy = false;
        content.querySelectorAll("button, select").forEach(element => { element.disabled = !!client.pending || (element.tagName === "SELECT" && !member?.permissions.manageDuty); });
        $("workspace-retry-write").hidden = !client.pending;
        $("workspace-retry-write").textContent = `Retry the same ${client.pendingKind}`;
      }
    }
  }
  function renderToday(data) {
    const header = node("div", null, "care-summary");
    header.append(node("p", date(data.date), "kicker"), node("h2", "A little care, shared."),
      node("p", data.summary.total ? `${data.summary.completed} of ${data.summary.total} check-ins completed` : "Room for one small check-in.", "care-count"),
      node("p", data.onDuty ? `${data.onDuty.memberName} is on duty until ${time(data.onDuty.endsAt)}.` : "Nobody is assigned today. A caregiver can arrange coverage in Circle."));
    const list = node("ul", null, "care-plan");
    for (const task of data.tasks) {
      const item = node("li"), copy = node("div");
      copy.append(node("p", `${time(task.dueAt)} · ${task.state === "scheduled" ? task.lastResponse === "not_yet" ? "Not yet" : "Awaiting check-in" : task.state}`, "kicker"), node("h3", task.title));
      if (task.confirmedBy) copy.append(node("p", `${task.confirmedBy} · ${time(task.confirmedAt)}`, "care-note"));
      item.append(copy);
      if (member.permissions.confirm && task.state === "scheduled") {
        const actions = node("div", null, "care-actions");
        for (const [response, label] of [["done", "Done"], ["not_yet", "Not yet"], ["skipped", "Skip today"]]) {
          actions.append(button(label, () => void mutate(() => client.confirm({ taskId: task.id, response, actor: member.name }), "Check-in recorded."), response !== "done"));
        }
        item.append(actions);
      }
      list.append(item);
    }
    if (!data.tasks.length) {
      const empty = node("li", null, "care-empty"), copy = node("div");
      copy.append(node("h3", "Nothing scheduled today."), node("p", member.permissions.manageDuty
        ? "Agree on one small thing together—a call, a walk, a glass of water. Give it a time, and your circle can follow along."
        : "Your caregiver can add an agreed-upon check-in. You can also look ahead at the shared plan.", "care-note"));
      const link = node("a", member.permissions.manageDuty ? "Schedule a check-in" : "View the plan", "primary care-plan-link");
      link.href = "#plan";
      empty.append(copy, link); list.append(empty);
    }
    const alerts = node("section", null, "care-alerts"); alerts.append(node("h3", "Family follow-up"));
    if (!data.escalations.length) alerts.append(node("p", "No missed-task alerts recorded today. This is not a safety check."));
    for (const alert of data.escalations) {
      const delivered = alert.status === "sent";
      alerts.append(node("p", `${data.tasks.find(task => task.id === alert.taskId)?.title ?? "Missed check-in"} · ${delivered ? "Notification accepted by the messaging service" : "Notification not confirmed"}${alert.recipientMemberName ? ` for ${alert.recipientMemberName}` : ""}.${alert.acknowledgedBy ? "" : " This does not mean someone has responded."}`));
      if (alert.acknowledgedBy) alerts.append(node("p", `${alert.acknowledgedBy} acknowledged this at ${time(alert.acknowledgedAt)}. The check-in itself is unchanged.`));
      else if (member.permissions.manageDuty) alerts.append(button("Acknowledge follow-up", () => void mutate(() => client.acknowledge(alert.id), "Follow-up acknowledged.")));
    }
    if (data.escalations.length) alerts.append(node("p", "Acknowledgment records that a caregiver has seen the follow-up. It does not confirm the task is done or cancel queued messages.", "care-note"));
    content.replaceChildren(header, list, alerts);
  }
  function renderCircle(data) {
    const heading = node("div"); heading.append(node("p", "Seven days, shared fairly", "kicker"), node("h2", "Who’s taking the next turn?"));
    const balance = node("p", null, "care-note");
    balance.textContent = data.members.filter(person => person.canReceiveAlerts).map(person => `${person.name}: ${data.assignments.filter(day => day.memberId === person.id).length} days`).join(" · ");
    const roster = node("div", null, "care-roster");
    for (const day of data.assignments) {
      const row = node("form", null, "care-roster-row"), label = node("label", date(day.date));
      const select = node("select"); select.id = `duty-${day.date}`; label.htmlFor = select.id;
      for (const person of data.members.filter(person => person.canReceiveAlerts)) select.add(new Option(person.name, person.id));
      select.value = day.memberId; select.disabled = !member.permissions.manageDuty;
      row.append(label, select);
      if (member.permissions.manageDuty) {
        const save = node("button", "Save handoff", "secondary"); save.type = "submit"; row.append(save);
        row.addEventListener("submit", event => { event.preventDefault(); void mutate(() => client.assignDuty({ date: day.date, memberId: select.value }), "Duty handoff saved."); });
      }
      roster.append(row);
    }
    if (!data.assignments.length) roster.append(node("p", "There is no rotation configured yet. Ask your circle organizer to set up coverage."));
    content.replaceChildren(heading, balance, roster, node("p", "A roster assignment does not grant account access or confirm SMS delivery. Existing alert recipients do not change when you hand off duty.", "care-note"));
  }
  function renderPlan(data) {
    const heading = node("div"); heading.append(node("p", "The next 30 days", "kicker"), node("h2", "Make space for the small things."), node("p", "Agree on an ordinary check-in, once or as a short daily routine. This is care coordination, not a medication recommendation."));
    const form = node("form", null, "invite-panel");
    if (member.permissions.manageDuty) {
      const titleLabel = node("label", "What is the check-in?"); titleLabel.htmlFor = "plan-title";
      const title = node("input"); title.id = "plan-title"; title.required = true; title.maxLength = 120; title.placeholder = "A glass of water, a walk, a call…";
      const dueLabel = node("label", `When? (${Intl.DateTimeFormat().resolvedOptions().timeZone})`); dueLabel.htmlFor = "plan-due";
      const due = node("input"); due.id = "plan-due"; due.type = "datetime-local"; due.required = true;
      const repeatLabel = node("label", "How often?"); repeatLabel.htmlFor = "plan-repeat";
      const repeat = node("select"); repeat.id = "plan-repeat";
      for (const [value, label] of [["1", "Just once"], ["7", "Daily · 7 check-ins"], ["14", "Daily · 14 check-ins"]]) repeat.add(new Option(label, value));
      const preview = node("p", "", "care-note"); preview.setAttribute("role", "status");
      function occurrences() {
        const first = new Date(due.value), times = [];
        const localStamp = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
        if (localStamp(first) !== due.value.slice(0, 16)) throw new Error("That local time is unavailable. Choose another start time.");
        for (let index = 0; index < Number(repeat.value); index++) {
          const next = new Date(first); next.setDate(first.getDate() + index);
          if (!Number.isFinite(next.getTime()) || next.getHours() !== first.getHours() || next.getMinutes() !== first.getMinutes()) throw new Error("That local time is unavailable during a clock change. Choose another time.");
          times.push(next.toISOString());
        }
        return times;
      }
      function updatePreview() {
        if (!due.value) { preview.textContent = "Choose a start time to review the dates."; return; }
        try { const times = occurrences(); preview.textContent = `${times.length} check-in${times.length === 1 ? "" : "s"} · ${new Date(times[0]).toLocaleString()}${times.length > 1 ? ` through ${new Date(times.at(-1)).toLocaleString()}. Stops after the last check-in; it does not renew.` : ""}`; }
        catch (error) { preview.textContent = error.message; }
      }
      due.addEventListener("change", updatePreview); repeat.addEventListener("change", updatePreview); updatePreview();
      const submit = node("button", "Save care plan", "primary"); submit.type = "submit";
      const note = node("p", "Keep every check-in within the next 30 days. You can rename or cancel future, untouched check-ins below. Time changes require a new routine. Missed check-ins may notify the caregiver on duty.", "care-note");
      form.append(titleLabel, title, dueLabel, due, repeatLabel, repeat, preview, note, submit);
      form.addEventListener("submit", event => {
        event.preventDefault(); if (!form.reportValidity()) return;
        const when = new Date(due.value);
        if (!Number.isFinite(when.getTime()) || when <= new Date() || when > new Date(Date.now() + 30 * 86400000)) { status.textContent = "Choose a future time within the next 30 days."; due.focus(); return; }
        let dueAts;
        try { dueAts = occurrences(); } catch (error) { status.textContent = error.message; due.focus(); return; }
        if (new Date(dueAts.at(-1)) > new Date(Date.now() + 30 * 86400000)) { status.textContent = "The entire routine must fit within the next 30 days."; due.focus(); return; }
        const input = dueAts.length === 1 ? { title: title.value.trim(), dueAt: dueAts[0] }
          : { title: title.value.trim(), dueAts, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
        void mutate(() => client.schedule(input), "Care plan saved.");
      });
    } else form.append(node("p", "Your role can view the plan. A caregiver can schedule new check-ins."));
    const list = node("ul", null, "care-plan");
    for (const task of data.tasks) { const row = node("li"), copy = node("div"); copy.append(node("h3", task.title), node("p", `${new Date(task.dueAt).toLocaleString()} · ${task.state}`, "care-note")); row.append(copy); list.append(row); }
    if (!data.tasks.length) list.append(node("li", "Your plan is empty. Start with one small, agreed-upon check-in."));
    const routines = node("section", null, "care-routines");
    if (member.permissions.manageDuty) {
      const groups = new Map();
      for (const task of data.tasks) {
        if (!task.routineId || task.state !== "scheduled" || task.lastResponse !== null || new Date(task.dueAt) <= new Date()) continue;
        if (!groups.has(task.routineId)) groups.set(task.routineId, []);
        groups.get(task.routineId).push(task);
      }
      if (groups.size) routines.append(node("h3", "Manage daily routines"), node("p", "Only future check-ins with no response can change. Completed, skipped, due, and ‘not yet’ check-ins stay in the history. This does not retract notifications already queued or sent.", "care-note"));
      for (const [routineId, tasks] of groups) {
        const details = node("details"), summary = node("summary", `${tasks[0].title} · ${tasks.length} future check-ins`);
        const edit = node("form", null, "invite-panel"), label = node("label", "Check-in wording");
        const title = node("input"); title.id = `routine-${routineId}`; title.value = tasks[0].title; title.maxLength = 120; title.required = true; label.htmlFor = title.id;
        const actionLabel = node("label", "Change"); const action = node("select"); action.id = `action-${routineId}`; actionLabel.htmlFor = action.id;
        action.add(new Option("Rename future check-ins", "rename")); action.add(new Option("Cancel future check-ins", "cancel"));
        action.addEventListener("change", () => { title.disabled = action.value === "cancel"; title.required = action.value === "rename"; consent.checked = false; });
        const confirmation = node("label", null, "consent-line"), consent = node("input"); consent.type = "checkbox"; consent.required = true;
        confirmation.append(consent, node("span", `I reviewed this change to ${tasks.length} future check-ins. Cancellation keeps a record; it cannot be undone here.`));
        const save = node("button", "Apply reviewed change", "secondary"); save.type = "submit";
        edit.append(node("p", `${new Date(tasks[0].dueAt).toLocaleString()} through ${new Date(tasks.at(-1).dueAt).toLocaleString()}`, "care-note"), label, title, actionLabel, action, confirmation, save);
        edit.addEventListener("submit", event => { event.preventDefault(); if (!edit.reportValidity()) return;
          void mutate(() => client.changeRoutine({ routineId, action: action.value, ...(action.value === "rename" ? { title: title.value.trim() } : {}),
            expected: tasks.map(({ id, title, dueAt }) => ({ id, title, dueAt })), confirm: true }), "Routine updated.");
        });
        details.append(summary, edit); routines.append(details);
      }
    }
    content.replaceChildren(heading, form, routines, list);
  }
  function renderBrief(data) {
    const heading = node("div"); heading.append(node("p", `${date(data.period.startDate)} – ${date(data.period.endDate)}`, "kicker"), node("h2", data.headline), node("p", data.overview));
    const facts = node("p", `${data.stats.completed} completed · ${data.stats.skipped} skipped · ${data.stats.stillOpen} still open`, "care-count");
    const points = node("div");
    for (const [title, rows] of [["What stood out", data.highlights], ["For your next conversation", data.followUps]]) {
      points.append(node("h3", title)); const list = node("ul");
      for (const point of rows) list.append(node("li", point.text));
      if (!rows.length) list.append(node("li", "No additional points in the recorded activity.")); points.append(list);
    }
    const evidence = node("details"); evidence.append(node("summary", `Based on ${data.evidence.length} recorded events`));
    for (const fact of data.evidence) evidence.append(node("p", fact.fact));
    const print = button("Print visit notes", () => window.print()); print.classList.add("no-print");
    content.replaceChildren(heading, facts, points, evidence, node("p", data.generatedBy === "bedrock" ? "Evidence selected with Amazon Bedrock; wording comes from recorded facts." : "Prepared directly from recorded activity; no generated interpretation.", "care-note"), node("p", data.safetyNotice, "care-note"), print);
  }
  function renderAccess(data) {
    const heading = node("div"); heading.append(node("p", "Organizer controls", "kicker"), node("h2", "Who can see your circle?"), node("p", "These are account memberships, not just names on the roster. Revoking access blocks future family-data requests; a request already in progress may finish."));
    const list = node("div", null, "care-roster");
    for (const person of data.members) {
      const row = node("form", null, "access-person");
      row.append(node("h3", person.name), node("p", `${person.role.replaceAll("_", " ")} · ${person.status}${person.organizer ? " · organizer" : ""}`));
      if (person.canRevoke) {
        const label = node("label", null, "consent-line"), checkbox = node("input"); checkbox.type = "checkbox"; checkbox.required = true;
        label.append(checkbox, node("span", `I want to revoke ${person.name}’s family access. This does not remove roster assignments or cancel SMS subscriptions.`));
        const submit = node("button", "Revoke access", "secondary"); submit.type = "submit";
        row.append(label, submit);
        row.addEventListener("submit", event => { event.preventDefault(); if (row.reportValidity()) void mutate(() => client.revoke(person.memberId), "Access revoked."); });
      }
      list.append(row);
    }
    if (!data.members.length) list.append(node("p", "No memberships were returned. Refresh or ask the account owner to check the circle configuration."));
    content.replaceChildren(heading, list, node("p", "This screen cannot revoke your own access or another organizer’s access, restore revoked access, or grant organizer privileges.", "care-note"));
  }
  async function refresh(afterWrite = false) {
    if (!member || (busy && !afterWrite) || loading || tab() === "invite") return;
    loading = true; const current = revision, view = tab();
    if (!content.childElementCount) status.textContent = "Loading your family’s update…";
    try {
      const identity = await client.session();
      const data = await (view === "plan" ? client.plan() : view === "access" ? client.access() : view === "week" ? client.brief() : view === "circle" ? client.circle() : client.today());
      if (current !== revision || view !== tab()) return;
      member = identity;
      $("workspace-invite-link").hidden = !member.permissions.invite;
      $("workspace-access-link").hidden = !member.permissions.invite;
      const serialized = JSON.stringify({ view, data, member });
      if (serialized !== lastRender || afterWrite) {
        (view === "plan" ? renderPlan : view === "access" ? renderAccess : view === "week" ? renderBrief : view === "circle" ? renderCircle : renderToday)(data);
        lastRender = serialized;
      }
      status.textContent = `Checked at ${time(new Date())}${view === "today" ? " · updates every 5 seconds" : ""}.`;
      if (client.pending) content.querySelectorAll("button, select").forEach(element => { element.disabled = true; });
    } catch (error) { if (current === revision) failure(error); }
    finally { if (current === revision) loading = false; }
  }
  async function navigate() {
    if (!member) return;
    if (busy || client.pending) { history.replaceState(null, "", `#${activeView}`); status.textContent = "Finish or retry the current change before switching views."; return; }
    revision += 1; loading = false; content.replaceChildren(); lastRender = "";
    const view = tab();
    activeView = view;
    if (view !== "invite") onLeaveInvite();
    $("invite-status").textContent = ""; $("invite-reload").hidden = true;
    $("workspace").hidden = view === "invite"; $("invitation-area").hidden = view !== "invite";
    document.querySelectorAll("#workspace-nav a").forEach(link => { if (link.hash === `#${view}`) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); });
    if (view === "invite") { await onInvite(); return; }
    await refresh();
  }
  async function poll() {
    if (!member) return;
    if (!document.hidden && tab() === "today") await refresh();
    timer = setTimeout(poll, 5000);
  }
  $("workspace-refresh").addEventListener("click", () => void refresh());
  $("workspace-retry-write").addEventListener("click", () => void mutate(() => client.retry(), "Check-in recorded."));
  window.addEventListener("hashchange", () => void navigate());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  return { reset, async open() {
    reset(); const current = revision;
    try {
      const identity = await client.session(); if (current !== revision) return;
      member = identity; $("workspace-identity").textContent = `${member.name} · ${member.permissions.invite ? "organizer" : member.role.replaceAll("_", " ")}`;
      document.querySelector("main").classList.add("workspace-ready");
      $("workspace-nav").hidden = false; $("workspace-invite-link").hidden = !member.permissions.invite;
      $("workspace-access-link").hidden = !member.permissions.invite;
      await navigate(); timer = setTimeout(poll, 5000);
    } catch (error) { failure(error); if (!error.stale && ![401, 403].includes(error.status)) onAccessLost(0); }
  } };
}
