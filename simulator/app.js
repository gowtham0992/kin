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

let snapshot = null;
let submitting = false;

function formatTime(iso) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
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

setLoading();
void loadToday();
