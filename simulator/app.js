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

let snapshot = null;
let submitting = false;
let weeklyBrief = null;
let loadingBrief = false;

function formatTime(iso) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
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
  const displayState = escalation ? "missed" : task.state;
  const item = document.createElement("li");
  item.className = `task ${["scheduled", "done", "skipped", "missed"].includes(displayState) ? displayState : "scheduled"}`;
  const mark = document.createElement("span");
  mark.className = "task-mark";
  mark.textContent = displayState === "done" ? "✓" : displayState === "skipped" ? "—" : displayState === "missed" ? "!" : "·";
  const copy = document.createElement("div");
  copy.className = "task-copy";
  const title = document.createElement("strong");
  title.textContent = task.title;
  const time = document.createElement("span");
  time.textContent = formatTime(task.dueAt);
  copy.append(title, time);
  const state = document.createElement("span");
  state.className = "task-state";
  state.textContent = displayState;
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
  if (weekView.hidden) phoneKicker.textContent = formatDate(data.date);
  progressCount.textContent = `${completed} of ${total}`;
  progressBar.style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
  const needsAttention = escalations.some((record) => ["sent", "blocked", "failed"].includes(record.status));
  progressMessage.textContent = needsAttention
    ? "1 check-in needs family attention"
    : remaining
      ? `${remaining} gentle check-in${remaining === 1 ? "" : "s"} left today`
      : "Everything is settled for today";
  syncLabel.textContent = "Live now";
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

  const next = data.tasks.find(
    (task) => task.state === "scheduled" && !escalationsByTask.has(task.id),
  );
  const latestSent = escalations.find((record) => record.status === "sent");
  echoTask.replaceChildren();
  const icon = document.createElement("div");
  icon.className = "prompt-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = next ? "☼" : latestSent ? "↗" : "✓";
  const copy = document.createElement("div");
  const label = document.createElement("p");
  const title = document.createElement("strong");
  label.textContent = next
    ? `Coming up · ${formatTime(next.dueAt)}`
    : latestSent
      ? "Your family is in the loop"
      : "All done";
  title.textContent = next
    ? next.title
    : latestSent
      ? `${latestSent.recipientMemberName ?? "Your caregiver"} has been notified.`
      : "You’re all set for today, Evelyn.";
  copy.append(label, title);
  echoTask.append(icon, copy);
  echoActions.hidden = !next;
  echoActions.dataset.taskId = next?.id ?? "";
  document.querySelector("#voice-line").textContent = next
    ? "Try saying: “Alexa, tell Kin I did it.”"
    : latestSent
      ? "Kin shared the missed check-in with the person on duty."
      : "Kin has quietly updated your family.";
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

async function loadWeeklyBrief() {
  if (loadingBrief) return;
  loadingBrief = true;
  setBriefLoading();
  try {
    const response = await fetch("/api/weekly-brief", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Could not load the weekly brief");
    renderBrief(await response.json());
  } catch {
    showBriefError();
  } finally {
    loadingBrief = false;
  }
}

function switchPhoneView(view) {
  const showWeek = view === "week";
  todayView.hidden = showWeek;
  weekView.hidden = !showWeek;
  phoneHeading.textContent = showWeek ? "This week" : "Mom’s day";
  phoneKicker.textContent = showWeek
    ? "A family handoff, grounded in facts"
    : snapshot
      ? formatDate(snapshot.date)
      : "Today";
  for (const button of phoneNav.querySelectorAll("button[data-view]")) {
    button.classList.toggle("active", button.dataset.view === view);
    button.setAttribute("aria-current", button.dataset.view === view ? "page" : "false");
  }
  if (showWeek && !weeklyBrief) void loadWeeklyBrief();
}

function renderEscalation(escalations) {
  const latest = escalations[0];
  const mark = escalationCard.querySelector(".escalation-mark");
  const label = escalationCard.querySelector("p");
  const message = escalationCard.querySelector("strong");
  escalationCard.className = "escalation-card";
  if (!latest) {
    mark.textContent = "✓";
    label.textContent = "Family coverage";
    message.textContent = "No missed check-ins";
    return;
  }

  escalationCard.classList.add(`is-${latest.status}`);
  if (latest.status === "sent") {
    mark.textContent = "↗";
    label.textContent = `Missed · ${formatTime(latest.dueAt)}`;
    message.textContent = `${latest.recipientMemberName ?? "On-duty caregiver"} was notified`;
    return;
  }
  if (latest.status === "blocked") {
    mark.textContent = "!";
    label.textContent = "Coverage needed";
    message.textContent = "No caregiver was on duty";
    return;
  }
  if (latest.status === "failed") {
    mark.textContent = "↻";
    label.textContent = "Delivery interrupted";
    message.textContent = "Kin will retry the alert";
    return;
  }
  mark.textContent = "···";
  label.textContent = "Missed check-in";
  message.textContent = "Alerting the on-duty caregiver";
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
}

async function loadToday() {
  setLoading();
  try {
    const response = await fetch("/api/today", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Could not load the care circle");
    render(await response.json());
  } catch {
    showError("Kin couldn’t reach the family circle.");
  }
}

async function confirmTask(responseValue) {
  const taskId = echoActions.dataset.taskId;
  if (!taskId || submitting) return;
  submitting = true;
  for (const button of echoActions.querySelectorAll("button")) button.disabled = true;
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ response: responseValue, actor: "Evelyn", requestId: crypto.randomUUID() }),
    });
    if (!response.ok) throw new Error("Confirmation failed");
    const result = await response.json();
    render(result.snapshot);
    toast.textContent = responseValue === "done" ? "Shared with Maya and Theo · just now" : "Kin will check in again a little later";
    toast.hidden = false;
    window.setTimeout(() => { toast.hidden = true; }, 2600);
  } catch {
    toast.textContent = "That didn’t go through. Nothing was changed.";
    toast.hidden = false;
  } finally {
    submitting = false;
    for (const button of echoActions.querySelectorAll("button")) button.disabled = false;
  }
}

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
