import { createConfirmationSender, createSnapshotReader } from "./care-client.js";
import { createMcpCareClient } from "./mcp-client.js";
import { createVoiceInput } from "./voice-input.js";

const mcp = createMcpCareClient(new URL("/mcp", location.origin));

const taskList = document.querySelector("#phone-tasks");
const echoTask = document.querySelector("#echo-task");
const echoActions = document.querySelector("#echo-actions");
const progressCount = document.querySelector("#progress-count");
const progressBar = document.querySelector("#progress-bar");
const progressMessage = document.querySelector("#progress-message");
const syncLabel = document.querySelector("#sync-label");
const toast = document.querySelector("#toast");
const dutyLabel = document.querySelector("#duty-label");
const escalationCard = document.querySelector("#escalation-card");
const todayView = document.querySelector("#today-view");
const weekView = document.querySelector("#week-view");
const circleView = document.querySelector("#circle-view");
const phoneHeading = document.querySelector("#phone-heading");
const phoneKicker = document.querySelector("#phone-kicker");
const phoneNav = document.querySelector(".phone-nav");
const briefPeriod = document.querySelector("#brief-period");
const briefHeadline = document.querySelector("#brief-headline");
const briefOverview = document.querySelector("#brief-overview");
const briefStats = document.querySelector("#brief-stats");
const briefPoints = document.querySelector("#brief-points");
const briefSource = document.querySelector("#brief-source");
const evidenceSummary = document.querySelector("#evidence-summary");
const evidenceList = document.querySelector("#evidence-list");
const briefSafety = document.querySelector("#brief-safety");
const rosterBalance = document.querySelector("#roster-balance");
const rosterDays = document.querySelector("#roster-days");

let snapshot = null;
let submitting = false;
let weeklyBrief = null;
let loadingBrief = false;
let circle = null;
let loadingCircle = false;
let refreshingToday = false;
let lastUpdatedAt = null;

const todayReader = createSnapshotReader({
  fetchSnapshot: () => mcp.today(),
  onSnapshot: (data) => {
    const changed = JSON.stringify(data) !== JSON.stringify(snapshot);
    lastUpdatedAt = new Date();
    render(data);
    if (changed) {
      weeklyBrief = null;
      if (!weekView.hidden) void loadWeeklyBrief();
    }
  },
  onError: () => {
    if (!snapshot) showError("Kin couldn’t reach the family circle.");
    else {
      syncLabel.textContent = `Connection lost · last checked ${formatTime(lastUpdatedAt)}`;
      document.querySelector("#connection-status").textContent = "Showing last known update";
    }
  },
});

const confirmationSender = createConfirmationSender({
  send: input => mcp.confirm(input),
});

function formatTime(iso) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function formatTimestamp(iso) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(iso));
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function formatShortDate(iso) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function setLoading() {
  escalationCard.hidden = true;
  taskList.replaceChildren();
  for (let index = 0; index < 2; index += 1) {
    const skeleton = document.createElement("li");
    skeleton.className = "task skeleton";
    skeleton.setAttribute("aria-hidden", "true");
    taskList.append(skeleton);
  }
}

function createTaskItem(task, escalation) {
  const displayState = task.state;
  const item = document.createElement("li");
  item.className = `task ${["scheduled", "done", "skipped"].includes(displayState) ? displayState : "scheduled"}`;
  const mark = document.createElement("span");
  mark.className = "task-mark";
  mark.textContent = displayState === "done" ? "✓" : displayState === "skipped" ? "—" : escalation ? "!" : "·";
  const copy = document.createElement("div");
  copy.className = "task-copy";
  const title = document.createElement("strong");
  title.textContent = task.title;
  const time = document.createElement("span");
  time.textContent = formatTime(task.dueAt);
  copy.append(title, time);
  const state = document.createElement("span");
  state.className = "task-state";
  state.textContent = displayState === "scheduled"
    ? task.lastResponse === "not_yet" ? "Not yet" : escalation ? "Follow-up" : "Awaiting check-in"
    : displayState;
  item.append(mark, copy, state);
  return item;
}

function render(data) {
  escalationCard.hidden = false;
  snapshot = data;
  const escalations = data.escalations ?? [];
  const escalationsByTask = new Map(escalations.map((record) => [record.taskId, record]));
  taskList.replaceChildren(...data.tasks.map((task) => createTaskItem(task, escalationsByTask.get(task.id))));
  const { completed, total, remaining } = data.summary;
  if (!todayView.hidden) phoneKicker.textContent = formatDate(data.date);
  progressCount.textContent = `${completed} of ${total}`;
  progressBar.style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
  const needsAttention = escalations.some((record) => ["sent", "blocked", "failed", "receipt_pending"].includes(record.status));
  const attentionCount = escalations.filter(record => ["sent", "blocked", "failed", "receipt_pending"].includes(record.status) && data.tasks.some(task => task.id === record.taskId && task.state === "scheduled")).length;
  progressMessage.textContent = needsAttention && attentionCount
    ? `${attentionCount} check-in${attentionCount === 1 ? "" : "s"} need${attentionCount === 1 ? "s" : ""} family attention`
    : remaining
      ? `${remaining} gentle check-in${remaining === 1 ? "" : "s"} left today`
      : "Everything is settled for today";
  syncLabel.textContent = "Checked just now · refreshes every 5s";
  document.querySelector("#connection-status").textContent = "Family updates connected";
  dutyLabel.textContent = data.onDuty
    ? `${data.onDuty.memberName} · until ${formatTime(data.onDuty.endsAt)}`
    : "No caregiver assigned";
  renderEscalation(escalations);

  const latest = escalations[0];
  if (latest) {
    const eventTime = formatTime(latest.updatedAt);
    document.querySelector("#echo-time").textContent = eventTime;
    document.querySelector(".phone-status span:first-child").textContent = eventTime;
  }

  const next = data.tasks.find(task => task.state === "scheduled");
  const latestSent = escalations.find((record) => record.status === "sent");
  echoTask.replaceChildren();
  const icon = document.createElement("div");
  icon.className = "prompt-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = next ? "☼" : latestSent ? "↗" : data.tasks.length ? "✓" : "·";
  const copy = document.createElement("div");
  const label = document.createElement("p");
  const title = document.createElement("strong");
  label.textContent = next
    ? `${next.lastResponse === "not_yet" ? "Reply: Not yet" : "Check-in"} · Due ${formatTime(next.dueAt)}`
    : latestSent
      ? "A family follow-up was submitted"
      : data.tasks.length ? "All done" : "No check-ins scheduled";
  title.textContent = next
    ? next.title
    : latestSent
      ? `An alert was submitted for ${latestSent.recipientMemberName ?? "your caregiver"}.`
      : data.tasks.length ? "You’re all set for today, Evelyn." : "Your family can add an agreed-upon check-in.";
  copy.append(label, title);
  echoTask.append(icon, copy);
  echoActions.hidden = !next;
  echoActions.dataset.taskId = next?.id ?? "";
  document.querySelector("#voice-line").textContent = next
    ? "Example voice request: “Alexa, tell Kin I did it.” Use the buttons in this simulation."
    : latestSent
      ? `Delivery is not confirmed. ${latestSent.acknowledgedBy ? `${latestSent.acknowledgedBy} acknowledged the follow-up.` : "No caregiver acknowledgment recorded."}`
      : data.tasks.length ? "Kin has quietly updated your family." : "There are no check-ins in today’s shared plan.";
}

function setBriefLoading() {
  briefHeadline.textContent = "Gathering the week…";
  briefOverview.textContent = "Kin is reading only the activity your family recorded.";
  briefStats.replaceChildren();
  briefPoints.replaceChildren();
  evidenceList.replaceChildren();
  briefSafety.textContent = "";
  briefSource.textContent = "Recorded facts";
}

function createStat(value, label) {
  const item = document.createElement("div");
  const number = document.createElement("strong");
  const copy = document.createElement("span");
  number.textContent = String(value);
  copy.textContent = label;
  item.append(number, copy);
  return item;
}

function renderBrief(brief) {
  weeklyBrief = brief;
  briefPeriod.textContent = `${formatDate(brief.period.startDate).replace(/^\w+, /, "")} — ${formatDate(brief.period.endDate).replace(/^\w+, /, "")}`;
  briefHeadline.textContent = brief.headline;
  briefOverview.textContent = brief.overview;
  briefStats.replaceChildren(
    createStat(brief.stats.completed, "completed"),
    createStat(brief.stats.stillOpen, "still open"),
    createStat(brief.stats.escalations, "alerts"),
  );
  const points = [...brief.highlights, ...brief.followUps.map((point) => ({ ...point, followUp: true }))];
  briefPoints.replaceChildren(...points.map((point) => {
    const item = document.createElement("li");
    if (point.followUp) item.className = "is-follow-up";
    const mark = document.createElement("span");
    mark.textContent = point.followUp ? "→" : "·";
    const copy = document.createElement("p");
    copy.textContent = point.text;
    item.append(mark, copy);
    return item;
  }));
  briefSource.textContent = brief.generatedBy === "bedrock" ? "Grounded by Nova" : "Recorded facts";
  evidenceSummary.textContent = `${brief.evidence.length} source event${brief.evidence.length === 1 ? "" : "s"}`;
  evidenceList.replaceChildren(...brief.evidence.map((evidence) => {
    const item = document.createElement("li");
    const time = document.createElement("span");
    const fact = document.createElement("p");
    time.textContent = formatShortDate(evidence.occurredAt);
    fact.textContent = evidence.fact;
    item.append(time, fact);
    return item;
  }));
  briefSafety.textContent = brief.safetyNotice;
}

function showBriefError() {
  briefHeadline.textContent = "The week isn’t available yet";
  briefOverview.textContent = "Today’s care circle is still live. Try the weekly view again in a moment.";
  briefStats.replaceChildren();
  briefPoints.replaceChildren();
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "brief-retry";
  retry.textContent = "Try again";
  retry.addEventListener("click", loadWeeklyBrief);
  briefPoints.append(retry);
}

function datesBetween(startDate, endDate) {
  const dates = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  while (cursor.toISOString().slice(0, 10) <= endDate) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function renderCircle(data) {
  circle = data;
  const caregivers = data.members.filter((member) => member.canReceiveAlerts);
  const assignmentByDate = new Map(data.assignments.map((assignment) => [assignment.date, assignment]));
  const counts = new Map(caregivers.map((member) => [member.id, 0]));
  for (const assignment of data.assignments) counts.set(assignment.memberId, (counts.get(assignment.memberId) ?? 0) + 1);
  rosterBalance.replaceChildren(...caregivers.map((member) => {
    const item = document.createElement("div");
    const avatar = document.createElement("span");
    const copy = document.createElement("p");
    avatar.textContent = member.name.slice(0, 1);
    copy.textContent = `${member.name} · ${counts.get(member.id) ?? 0} day${counts.get(member.id) === 1 ? "" : "s"}`;
    item.append(avatar, copy);
    return item;
  }));
  rosterDays.replaceChildren(...datesBetween(data.startDate, data.endDate).map((date, index) => {
    const item = document.createElement("li");
    const day = document.createElement("div");
    const weekday = document.createElement("strong");
    const calendar = document.createElement("span");
    const select = document.createElement("select");
    weekday.textContent = index === 0 ? "Today" : new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
    calendar.textContent = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
    day.append(weekday, calendar);
    select.setAttribute("aria-label", `Caregiver on duty ${date}`);
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Unassigned";
    select.append(empty, ...caregivers.map((member) => {
      const option = document.createElement("option");
      option.value = member.id;
      option.textContent = member.name;
      return option;
    }));
    select.value = assignmentByDate.get(date)?.memberId ?? "";
    select.addEventListener("change", () => {
      if (!select.value) {
        select.value = assignmentByDate.get(date)?.memberId ?? "";
        return;
      }
      void saveDuty(date, select.value, select);
    });
    item.append(day, select);
    return item;
  }));
}

async function loadCircle() {
  if (loadingCircle) return;
  loadingCircle = true;
  try {
    const response = await fetch("/api/circle", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Could not load roster");
    renderCircle(await response.json());
  } catch {
    rosterDays.replaceChildren();
    const item = document.createElement("li");
    item.textContent = "The family roster isn’t available yet.";
    rosterDays.append(item);
  } finally {
    loadingCircle = false;
  }
}

async function saveDuty(date, memberId, select) {
  select.disabled = true;
  try {
    const response = await fetch("/api/circle/duty", {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ date, memberId }),
    });
    if (!response.ok) throw new Error("Could not update roster");
    const updated = await response.json();
    renderCircle(updated);
    if (snapshot?.date === date) await loadToday();
    toast.textContent = "Duty handoff shared with the family";
    toast.hidden = false;
    window.setTimeout(() => { toast.hidden = true; }, 2200);
  } catch {
    toast.textContent = "Kin couldn’t confirm that handoff. Reopen Circle to check the saved roster.";
    toast.hidden = false;
    renderCircle(circle);
  } finally {
    select.disabled = false;
  }
}

async function loadWeeklyBrief() {
  if (loadingBrief) return;
  loadingBrief = true;
  setBriefLoading();
  try {
    renderBrief(await mcp.brief());
  } catch {
    showBriefError();
  } finally {
    loadingBrief = false;
  }
}

function switchPhoneView(view) {
  const showWeek = view === "week";
  const showCircle = view === "circle";
  todayView.hidden = showWeek || showCircle;
  weekView.hidden = !showWeek;
  circleView.hidden = !showCircle;
  phoneHeading.textContent = showCircle ? "Our circle" : showWeek ? "This week" : "Mom’s day";
  phoneKicker.textContent = showCircle
    ? "Maya + Theo"
    : showWeek
      ? "A family handoff, grounded in facts"
      : snapshot
        ? formatDate(snapshot.date)
        : "Today";
  for (const button of phoneNav.querySelectorAll("button[data-view]")) {
    button.classList.toggle("active", button.dataset.view === view);
    button.setAttribute("aria-current", button.dataset.view === view ? "page" : "false");
  }
  if (showWeek) void loadWeeklyBrief();
  if (showCircle) void loadCircle();
}

function renderEscalation(escalations) {
  const latest = escalations[0];
  const mark = escalationCard.querySelector(".escalation-mark");
  const label = escalationCard.querySelector("p");
  const message = escalationCard.querySelector("strong");
  escalationCard.className = "escalation-card";
  if (!latest) {
    mark.textContent = "✓";
    label.textContent = "Family follow-up";
    message.textContent = "No follow-up alerts listed";
    return;
  }

  const due = `Due ${formatTimestamp(latest.dueAt)}`;
  const acknowledgment = latest.acknowledgedBy
    ? `${latest.acknowledgedBy} acknowledged the follow-up.`
    : "No caregiver acknowledgment recorded.";
  escalationCard.classList.add(`is-${latest.status}`);
  if (latest.status === "sent") {
    mark.textContent = "↗";
    label.textContent = `Follow-up · ${due}`;
    message.textContent = `Notification accepted by the messaging service for ${latest.recipientMemberName ?? "the on-duty caregiver"}; delivery unconfirmed. ${acknowledgment}`;
    return;
  }
  if (latest.status === "blocked") {
    mark.textContent = "!";
    label.textContent = `Coverage needed · ${due}`;
    message.textContent = `No caregiver was on duty when this follow-up was recorded. ${acknowledgment}`;
    return;
  }
  if (latest.status === "receipt_pending") {
    mark.textContent = "!";
    label.textContent = `Receipt review needed · ${due}`;
    message.textContent = `The messaging service accepted the notification, but its receipt needs review. Kin will not automatically resend it; delivery is unconfirmed. ${acknowledgment}`;
    return;
  }
  if (latest.status === "failed") {
    mark.textContent = "↻";
    label.textContent = `Delivery interrupted · ${due}`;
    message.textContent = `Notification not confirmed. Kin will retry the alert. ${acknowledgment}`;
    return;
  }
  mark.textContent = "···";
  label.textContent = `Family follow-up · ${due}`;
  message.textContent = `Notification awaiting confirmation. ${acknowledgment}`;
}

function showError(message) {
  escalationCard.hidden = true;
  taskList.replaceChildren();
  const error = document.createElement("li");
  error.className = "task error";
  error.textContent = message;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Try again";
  retry.addEventListener("click", loadToday);
  error.append(document.createElement("br"), retry);
  taskList.append(error);
  syncLabel.textContent = "Offline";
  document.querySelector("#connection-status").textContent = "Family updates unavailable";
}

async function loadToday() {
  if (refreshingToday || submitting) return;
  refreshingToday = true;
  if (!snapshot) setLoading();
  try { await todayReader.read(); }
  finally { refreshingToday = false; }
}

async function confirmTask(responseValue) {
  const taskId = echoActions.dataset.taskId;
  if (!taskId || submitting || conversationBusy || voice.active || confirmationSender.pending) return;
  // Bind the button to the task actually displayed, never a newly fetched review.
  const task = snapshot?.tasks.find(task => task.id === taskId && task.state === "scheduled");
  if (!task) return;
  const expected = Object.fromEntries(["title", "dueAt", "state", "lastResponse", "confirmedAt", "confirmedBy"].map(key => [key, task[key]]));
  await submitConfirmation(() => confirmationSender.confirm({ taskId, response: responseValue, actor: "Evelyn", expected }));
}

async function submitConfirmation(send) {
  if (submitting) return false;
  submitting = true;
  todayReader.invalidate();
  for (const button of echoActions.querySelectorAll("button")) button.disabled = true;
  try {
    const result = await send();
    weeklyBrief = null;
    if (result.snapshot) { lastUpdatedAt = new Date(); render(result.snapshot); }
    toast.textContent = result.refreshRequired
      ? "Your answer is saved. The full plan will refresh when the connection returns."
      : result.confirmation.response === "done"
        ? "Saved to the family circle"
        : result.confirmation.response === "skipped" ? "Saved as skipped to the family circle."
        : "Saved as not yet done. The original check-in time is unchanged.";
    toast.hidden = false;
    window.setTimeout(() => { if (!confirmationSender.pending && !submitting) toast.hidden = true; }, 4000);
    return true;
  } catch {
    toast.textContent = confirmationSender.pending
      ? "Kin hasn’t confirmed this save. It may already be recorded."
      : "Kin did not accept that answer. Refresh the plan and try again.";
    if (confirmationSender.pending) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Check this save again";
      retry.addEventListener("click", () => void submitConfirmation(() => confirmationSender.retry()));
      toast.append(" ", retry);
    }
    toast.hidden = false;
    return false;
  } finally {
    submitting = false;
    for (const button of echoActions.querySelectorAll("button")) button.disabled = Boolean(confirmationSender.pending);
    void loadToday();
  }
}

const conversationForm = document.querySelector("#conversation-form");
const conversationInput = document.querySelector("#conversation-input");
const conversationStatus = document.querySelector("#conversation-status");
const conversationReview = document.querySelector("#conversation-review");
let proposal = null, conversationBusy = false;
let conversationContextToken;

function lockConversation(locked) {
  document.querySelectorAll(".conversation button, .conversation input").forEach(element => { element.disabled = locked; });
  document.querySelector("#voice-start").disabled = locked || !voice.supported;
}
const voiceButton = document.querySelector("#voice-start");
const voiceCancel = document.querySelector("#voice-cancel");
const voiceStatus = document.querySelector("#voice-status");
const voice = createVoiceInput({
  Recognition: window.SpeechRecognition ?? window.webkitSpeechRecognition,
  onState: phase => {
    const active = phase !== "idle";
    lockConversation(active || conversationBusy || submitting || !!confirmationSender.pending);
    voiceCancel.hidden = !active; voiceCancel.disabled = false;
    voiceButton.disabled = phase === "finishing" || (!active && (conversationBusy || submitting || !!confirmationSender.pending));
    voiceButton.textContent = phase === "listening" ? "Stop listening" : phase === "finishing" ? "Finishing…" : "Use voice input";
    voiceStatus.textContent = phase === "listening" ? "Listening. Say one short message; nothing will be submitted."
      : phase === "finishing" ? "Finishing your transcript…" : "Microphone stopped. You can type or try voice again.";
  },
  onTranscript: text => {
    const draft = [conversationInput.value.trim(), text].filter(Boolean).join(" ");
    if (draft.length > 800) { voiceStatus.textContent = "The combined message is too long. Your original draft was kept."; return; }
    conversationInput.value = draft;
    voiceStatus.textContent = "Added to your draft. Review the text, then press Ask Kin. Nothing has been sent to Kin.";
    conversationInput.focus();
  },
  onError: message => { voiceStatus.textContent = message; },
});
voiceButton.disabled = !voice.supported;
voiceStatus.textContent = voice.supported ? "Voice input starts only when you press the button." : "Voice input is unavailable in this browser. Typed messages work normally.";
voiceButton.addEventListener("click", () => {
  if (voice.active) { voice.stop(); return; }
  if (conversationBusy || submitting || confirmationSender.pending) return;
  proposal = null; conversationReview.hidden = true;
  voice.start();
});
voiceCancel.addEventListener("click", () => voice.cancel());
document.addEventListener("visibilitychange", () => { if (document.hidden) voice.cancel(); });
window.addEventListener("pagehide", () => voice.cancel());
conversationForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (conversationBusy || voice.active || submitting || confirmationSender.pending) {
    conversationStatus.textContent = "Finish or retry the current check-in first."; return;
  }
  conversationBusy = true; lockConversation(true); proposal = null; conversationReview.hidden = true;
  conversationStatus.textContent = "Checking your request…";
  try {
    const response = await fetch("/demo/conversation", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: conversationInput.value, contextToken: conversationContextToken }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Interpretation unavailable");
    const result = await response.json();
    conversationContextToken = result.contextToken;
    document.querySelector("#conversation-mode").textContent = result.mode === "bedrock"
      ? "Bedrock interpreted this request. Review its suggestion; it can be wrong."
      : "Limited-command mode · no language model used.";
    if (result.action === "confirm" && result.task && ["done", "not_yet", "skipped"].includes(result.response)) {
      proposal = result;
      document.querySelector("#conversation-proposal").textContent = `Record “${result.task.title}” (${formatTime(result.task.dueAt)}) as ${result.response.replace("_", " ")} for Evelyn?`;
      conversationReview.hidden = false;
      conversationStatus.textContent = "Please review. No change has been saved. You can also ask a follow-up, such as ‘actually not yet’. Task context lasts five minutes.";
    } else if (result.action === "today") {
      const data = await mcp.today(); render(data);
      conversationStatus.textContent = `${data.summary.completed} of ${data.summary.total} check-ins are complete. ${data.tasks.map(task => `${task.title}: ${task.state}`).join(". ") || "No check-ins are scheduled."}`;
    } else if (result.action === "brief") {
      const brief = await mcp.brief();
      conversationStatus.textContent = `${brief.headline}. ${brief.overview} ${brief.safetyNotice}`;
    } else conversationStatus.textContent = "I need a clearer request. Name the task and whether it is done, not yet, or skipped. I cannot assess health or handle emergencies; nothing has changed.";
  } catch {
    conversationStatus.textContent = "Kin couldn’t finish this request. Your message is still here; try again. No check-in was sent.";
  } finally { conversationBusy = false; lockConversation(false); }
});
document.querySelector("#conversation-cancel").addEventListener("click", () => {
  conversationContextToken = undefined;
  proposal = null; conversationReview.hidden = true;
  conversationStatus.textContent = "Left unchanged."; conversationInput.focus();
});
document.querySelector("#conversation-confirm").addEventListener("click", async () => {
  if (!proposal || conversationBusy || voice.active || submitting || confirmationSender.pending) return;
  const reviewed = proposal; conversationBusy = true; lockConversation(true);
  try {
    const latest = await mcp.today();
    const task = latest.tasks.find(task => task.id === reviewed.task.id);
    if (!task || task.state !== "scheduled" || task.title !== reviewed.task.title || task.dueAt !== reviewed.task.dueAt
      || task.lastResponse !== reviewed.task.lastResponse || task.confirmedAt !== reviewed.task.confirmedAt) {
      proposal = null; conversationReview.hidden = true;
      conversationStatus.textContent = "That check-in changed since your request. Ask again to review the current plan."; return;
    }
    const saved = await submitConfirmation(() => confirmationSender.confirm({ taskId: task.id, response: reviewed.response, actor: "Evelyn", expected: reviewed.expected }));
    proposal = null; conversationReview.hidden = true;
    conversationStatus.textContent = saved ? "Your check-in is saved to the shared family plan." : confirmationSender.pending
      ? "The save was not acknowledged. Use the save message’s retry button before sending another check-in."
      : "The task changed or the answer was rejected. Ask again to review the current plan.";
    conversationContextToken = undefined;
    if (saved) conversationInput.value = "";
  } catch { conversationStatus.textContent = "Kin couldn’t check the current plan. Nothing was sent; try confirming again."; }
  finally { conversationBusy = false; lockConversation(false); }
});

echoActions.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-response]");
  if (button) void confirmTask(button.dataset.response);
});

phoneNav.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (button) switchPhoneView(button.dataset.view);
});

setLoading();
void loadToday();

function refreshVisibleViews() {
  if (document.visibilityState !== "visible" || submitting) return;
  void loadToday();
  if (!circleView.hidden && !circleView.contains(document.activeElement)) void loadCircle();
}
window.setInterval(refreshVisibleViews, 5000);
window.addEventListener("focus", refreshVisibleViews);
window.addEventListener("online", refreshVisibleViews);
document.addEventListener("visibilitychange", refreshVisibleViews);
