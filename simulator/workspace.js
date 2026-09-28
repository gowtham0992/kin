import { createWorkspaceClient, createPlanDraft, dutyDays } from "./workspace-client.js";
import { createVoiceInput, appendVoiceDraft } from "./voice-input.js";
import { createRosterDraft, renderRosterEditor } from "./roster-editor.js";
import { renderDutyRotation } from "./duty-rotation.js";
import { createPushControls } from "./push-controls.js";
import { renderPlanPause, pauseSavedMessage } from "./plan-pause.js";

const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const element = document.createElement(tag); if (text != null) element.textContent = text; if (className) element.className = className; return element; };
const date = value => new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const time = value => new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const timestamp = value => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));

export function createWorkspace({ request, onAccessLost, onInvite, onLeaveInvite, loadMcpClient = () => import("/mcp-client.js") }) {
  const pushControls = createPushControls({ request, container: $("workspace-push") });
  let sessionGeneration = 0, mcpConnection = null, mcpTracePanel = null;
  const mcpTrace = [];
  function renderMcpTrace() {
    if (!mcpTracePanel) return;
    const list = node("ol");
    for (const event of mcpTrace) list.append(node("li", `${event.tool} · ${event.phase}${event.rpcId !== undefined ? ` · RPC ${event.rpcId}` : ""}${event.durationMs !== undefined ? ` · ${event.durationMs} ms` : ""}${event.result?.response ? ` · ${event.result.response.replaceAll("_", " ")}` : ""}`));
    mcpTracePanel.replaceChildren(node("summary", `MCP request trace · ${mcpTrace.length} events`),
      node("p", "Actual client requests and results; no tokens or care text are shown.", "care-note"), list);
  }
  async function getMcp() {
    if (mcpConnection) return mcpConnection;
    const current = sessionGeneration, module = await loadMcpClient();
    if (current !== sessionGeneration) throw Object.assign(new Error("Session changed"), { stale: true });
    mcpConnection = module.createMcpCareClient(new URL("/mcp", location.origin), { clientName: "kin-family-workspace",
      fetch: async (url, options) => {
        if (current !== sessionGeneration) throw Object.assign(new Error("Session changed"), { stale: true });
        const response = await request(String(url), options);
        if (current !== sessionGeneration) throw Object.assign(new Error("Session changed"), { stale: true });
        return response;
      }, onTrace: event => {
        if (current !== sessionGeneration) return;
        mcpTrace.push(event); if (mcpTrace.length > 40) mcpTrace.shift(); renderMcpTrace();
      } });
    return mcpConnection;
  }
  const client = createWorkspaceClient({ request, mcp: getMcp });
  const planDraft = createPlanDraft(), rosterDraft = createRosterDraft(), disabledBeforeSave = new WeakMap();
  const taskChangeDrafts = new Map();
  let rosterEditor = null;
  let rotationEditor = null;
  let pauseEditor = null;
  let conversationDraft = "";
  let conversationSelection = null;
  let voice = null;
  let briefEvidence = null, printedEvidence = null, briefCitationGroups = [];
  let undoReviewTimer = null;
  let member = null, revision = 0, busy = false, loading = false, timer = null, lastRender = "", activeView = null;
  let loadingPanel = null;
  const content = $("workspace-content"), status = $("workspace-status");
  const viewLabels = { today: "Today", ask: "Ask Kin", plan: "Plan", turns: "Turns", circle: "Turns", week: "Week", invite: "Invite family", access: "Access" };
  const isTurns = view => view === "turns" || view === "circle";
  const tab = () => location.hash === "#workspace-main" ? activeView ?? "today"
    : Object.hasOwn(viewLabels, location.hash.slice(1)) ? location.hash.slice(1) : "today";
  function syncNavigation() {
    $("workspace-ask-link").hidden = !member.permissions.confirm;
    $("workspace-management").hidden = !member.permissions.invite;
    $("workspace-invite-link").hidden = !member.permissions.invite;
    $("workspace-access-link").hidden = !member.permissions.invite;
    $("workspace-secondary").hidden = !member.permissions.confirm && !member.permissions.invite;
  }
  function authorNote() {
    return node("p", `Updates are recorded via ${member.name}’s Kin account${member.role === "caregiver" ? " · caregiver." : "."} Anyone using this signed-in session can act with its permissions. Kin cannot verify who is speaking. Share only what you personally know.`, "care-note care-author-note");
  }
  function clearPlanDraft() {
    planDraft.clear();
    for (const [id, value] of [["plan-title", ""], ["plan-due", ""], ["plan-repeat", "1"]]) { if ($(id)) $(id).value = value; }
    $("plan-due")?.dispatchEvent(new Event("change"));
  }
  function reset() {
    pauseEditor?.destroy(); pauseEditor = null;
    clearTimeout(undoReviewTimer);
    pushControls.reset();
    sessionGeneration += 1; mcpConnection = null; mcpTrace.length = 0; mcpTracePanel = null;
    rotationEditor?.destroy(); rotationEditor = null;
    restorePrintedEvidence(); briefEvidence = null; briefCitationGroups = [];
    voice?.cancel(); voice = null;
    revision += 1; client.reset(); planDraft.clear(); taskChangeDrafts.clear(); rosterDraft.clear(); rosterEditor = null; conversationDraft = ""; conversationSelection = null; member = null; busy = false; loading = false; activeView = null;
    clearTimeout(timer); content.replaceChildren(); loadingPanel = null; content.removeAttribute("aria-busy"); $("workspace").hidden = true;
    $("workspace-nav").hidden = true; $("workspace-identity").textContent = "";
    $("workspace-navigation").hidden = true; $("workspace-secondary").hidden = true;
    $("workspace-retry-write").hidden = true;
    document.querySelector("main").classList.remove("workspace-ready"); lastRender = "";
  }
  function failure(error) {
    if (error.stale) return;
    if ([401, 403].includes(error.status)) {
      const requestId = client.pending?.requestId;
      const uncertain = error.outcomeUnknown === true && typeof requestId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(requestId)
        ? { outcomeUnknown: true, requestId } : null;
      // Keep only an opaque reference for the closed-session notice. A new login
      // must never inherit this session's private task snapshot or retry intent.
      reset();
      if (uncertain) onAccessLost(error.status, uncertain); else onAccessLost(error.status);
      return;
    }
    status.textContent = "Could not refresh. Any visible information is the last known update. Check your connection and try again.";
    if (!content.childElementCount || loadingPanel) content.replaceChildren(node("h2", `${viewLabels[tab()]} is temporarily unavailable.`),
      node("p", "Use Refresh to try again. Your unsaved draft stays in this session.", "care-note"));
  }
  function renderLoading(view) {
    loadingPanel = node("section", null, "care-loading");
    const placeholders = node("div", null, "care-loading-lines");
    placeholders.setAttribute("aria-hidden", "true");
    placeholders.append(node("span"), node("span"), node("span"));
    loadingPanel.append(node("h2", `Loading ${viewLabels[view]}…`),
      node("p", "You can switch tabs while this loads.", "care-note"), placeholders);
    content.setAttribute("aria-busy", "true");
    content.replaceChildren(loadingPanel);
  }
  function button(label, action, secondary = true) {
    const element = node("button", label, secondary ? "secondary" : "primary"); element.type = "button";
    element.addEventListener("click", action); return element;
  }
  function lockControls(locked) {
    content.querySelectorAll("button, input, select, textarea").forEach(element => {
      if (locked) { if (!disabledBeforeSave.has(element)) disabledBeforeSave.set(element, element.disabled); element.disabled = true; }
      else if (disabledBeforeSave.has(element)) { element.disabled = disabledBeforeSave.get(element); disabledBeforeSave.delete(element); }
    });
  }
  async function mutate(action, success, onSaved = () => {}, kind = "plan") {
    if (busy || voice?.active) return;
    if (rotationEditor?.loading) { status.textContent = "Wait for the rotation proposal before saving another change."; return; }
    if (pauseEditor?.loading) { status.textContent = "Wait for the cancellation review before saving another change."; return; }
    const current = ++revision; busy = true; loading = false;
    lockControls(true);
    status.textContent = "Saving…";
    try {
      await action(); if (current !== revision) return;
      onSaved();
      const refreshed = await refresh(true);
      if (current === revision) status.textContent = refreshed ? success : `${success} The latest view could not be refreshed; use Refresh to check it.`;
    }
    catch (error) {
      if (current !== revision) return;
      failure(error);
      if (![401, 403].includes(error.status)) status.textContent = client.pending
        ? `Kin has not acknowledged this ${client.pendingKind}. Retry the same request below; do not submit a different one yet.`
        : "The change was not acknowledged. Refresh to check the current state before trying again.";
      if (error.status === 409 && !client.pending) status.textContent = kind === "duty"
        ? "The duty roster changed while you were reviewing it. Refresh, then review the current assignment again."
        : kind === "roster" ? "This name may already be in the circle, or the person’s name or access changed. Your draft is still here. Refresh and review the current circle before trying again."
        : "The plan changed while you were reviewing it. Refresh, then review the current check-ins again.";
      if (error.status === 400 && kind === "roster" && !client.pending) status.textContent = "Use a name of 1–80 characters without control or directional characters. Your draft is still here.";
      if (kind === "pause" && !client.pending && ![401, 403].includes(error.status)) {
        pauseEditor?.destroy(); pauseEditor = null; lastRender = ""; await refresh(true);
        if (current === revision) status.textContent = error.status === 404
          ? "Pausing is no longer available. The plan was not changed by this request."
          : "The plan changed or the cancellation review expired. Nothing was cancelled by this request. Review the current plan again.";
      }
      if (kind === "undo" && !client.pending && ![401, 403].includes(error.status)) {
        client.cancelUndoReview(); clearTimeout(undoReviewTimer); lastRender = "";
        await refresh(true);
        if (current === revision) status.textContent = error.status === 404
          ? "Completion undo is no longer available. Check the current plan."
          : "That completion changed or the undo review expired. Nothing was undone by this request. Review the current plan.";
      }
    } finally {
      if (current === revision) {
        busy = false;
        lockControls(!!client.pending);
        $("workspace-retry-write").hidden = !client.pending;
        $("workspace-retry-write").textContent = `Retry the same ${client.pendingKind}`;
      }
    }
  }
  function completionUndoOffer(data) {
    if (!member.permissions.confirm || !client.undoOffer(data)) return null;
    const section = node("section", null, "care-undo-offer no-print");
    const copy = node("div");
    copy.append(node("p", "Just recorded", "kicker"), node("h3", "Marked done by mistake?"),
      node("p", "Your latest completion can be undone for five minutes. Review what will change before saving.", "care-note"));
    const open = button("Review undo", () => void reviewCompletionUndo()); open.id = "workspace-review-undo";
    section.append(copy, open); return section;
  }
  async function reviewCompletionUndo() {
    if (busy || client.pending || voice?.active) return;
    const current = ++revision; busy = true; loading = false; lockControls(true);
    status.textContent = "Checking the completion before review…";
    try {
      const undo = await client.prepareUndo(); if (current !== revision) return;
      const section = node("section", null, "care-undo-review no-print"), heading = node("h2", "Undo this completion?");
      heading.id = "workspace-undo-heading"; heading.tabIndex = -1;
      const restore = undo.restore, changes = node("dl", null, "care-undo-changes");
      changes.append(node("dt", "Now"), node("dd", `Done · via ${undo.expected.confirmedBy}’s Kin account · ${timestamp(undo.expected.confirmedAt)}`),
        node("dt", "Restore"), node("dd", restore.lastResponse === "not_yet"
          ? `Not yet · via ${restore.confirmedBy}’s Kin account · ${timestamp(restore.confirmedAt)}` : "Awaiting check-in · no response recorded"));
      const note = node("p", "The earlier response and its original time will be restored. Canceled reminders will not restart, and delivered family alerts cannot be recalled.", "care-note");
      const expiry = node("p", "Please confirm within 90 seconds, before the five-minute undo window ends.", "care-note");
      expiry.setAttribute("role", "status");
      const actions = node("div", null, "care-actions");
      const save = button("Confirm undo", () => void mutate(() => client.undoCompletion(),
        "Completion undone. The earlier response was restored; canceled reminders stay canceled.", () => { clearTimeout(undoReviewTimer); }, "undo"), false);
      save.id = "workspace-confirm-undo";
      const cancel = button("Keep completion", async () => {
        if (busy || client.pending) return;
        client.cancelUndoReview(); clearTimeout(undoReviewTimer); lastRender = "";
        await refresh(); $("workspace-review-undo")?.focus();
      });
      actions.append(save, cancel);
      section.append(node("p", "Review a correction", "kicker"), heading, node("h3", undo.expected.title),
        node("p", `Scheduled for ${timestamp(undo.expected.dueAt)}`, "care-note"), changes, note, expiry, actions);
      content.replaceChildren(section); lastRender = ""; heading.focus();
      clearTimeout(undoReviewTimer);
      undoReviewTimer = setTimeout(() => {
        if (current !== revision || !client.undoReviewing || client.pending) return;
        save.disabled = true; expiry.textContent = "This review expired. Keep the completion, then review the current plan again.";
      }, Math.max(0, Math.min(90_000, undo.recordedAt + 300_000 - Date.now())));
      status.textContent = "Nothing changes until you confirm this undo.";
    } catch (error) {
      if (current !== revision) return;
      failure(error);
      if (![401, 403].includes(error.status)) status.textContent = error.status === 409
        ? "That completion changed or the five-minute undo window expired. Refresh to review the current plan."
        : "Could not check this completion. Nothing was sent to undo it. Try Review undo again.";
    } finally { if (current === revision) { busy = false; lockControls(false); } }
  }
  function renderConversation(data) {
    voice?.cancel(); voice = null;
    const heading = node("div", null, "care-conversation-heading");
    heading.append(node("p", "A moment with Kin", "kicker"), node("h2", "How did it go?"));
    const usesMcp = member.mcpConversation === true;
    if (usesMcp) heading.append(node("p", "Simulated Alexa+ experience · real MCP", "care-mcp-badge"),
      node("p", "Not connected to Alexa or an Echo device.", "care-note"));
    if (!member.permissions.confirm) {
      content.replaceChildren(heading, node("p", "Your membership allows viewing the plan, but not recording check-ins.")); return;
    }
    heading.append(authorNote());
    const openTasks = data.tasks.filter(task => task.state === "scheduled").sort((left, right) => new Date(left.dueAt) - new Date(right.dueAt));
    const currentTask = openTasks[0];
    const form = node("form", null, "care-conversation"), label = node("label", "Your words, ready to review"), input = node("input");
    input.id = "care-request"; label.htmlFor = input.id; input.required = true; input.maxLength = 800; input.value = conversationDraft;
    input.autocomplete = "off";
    input.placeholder = currentTask ? "Tell Kin how it went" : "Show today";
    const hint = node("p", "Simple replies like “I had my water” or “I haven’t had my water yet” work when they match one check-in. Kin will ask you to choose if it is unsure. You can also use Show today, Weekly brief, or Done:, Not yet: and Skip: followed by the exact title. These replies do not use a language model.", "care-note");
    hint.id = "care-request-hint"; input.setAttribute("aria-describedby", "care-draft-note care-request-hint care-selected-task");
    const selectionNote = node("p", null, "care-note"); selectionNote.id = "care-selected-task";
    const renderSelection = () => {
      selectionNote.hidden = !conversationSelection;
      selectionNote.textContent = conversationSelection ? `Selected check-in: ${conversationSelection.title} · ${timestamp(conversationSelection.dueAt)}` : "";
    };
    renderSelection();
    const submit = node("button", "Review request", "primary"); submit.type = "submit";
    const naturalLanguage = member.conversation?.naturalLanguage === true;
    const consent = node("input"), modelSubmit = node("button", "Review with Bedrock", "secondary");
    consent.type = "checkbox"; consent.id = "care-transfer-consent";
    modelSubmit.type = "submit"; modelSubmit.disabled = true; modelSubmit.dataset.mode = "bedrock";
    const clearTransferConsent = () => { consent.checked = false; modelSubmit.disabled = true; };
    consent.addEventListener("change", () => { modelSubmit.disabled = !consent.checked || busy || !!voice?.active; });
    const reply = node("p", "Nothing changes until you review and confirm.", "care-note"); reply.setAttribute("role", "status");
    const review = node("div", null, "care-alerts care-conversation-review"); review.hidden = true;
    const voiceStatus = node("p", "Voice input starts only when you press the button.", "care-note"); voiceStatus.setAttribute("role", "status");
    const voiceStart = button("Use voice input", () => {
      if (busy || client.pending) return;
      if (voice.active) voice.stop();
      else { review.hidden = true; clearTransferConsent(); voice.start(); }
    }, false);
    voiceStart.classList.add("care-voice-start");
    voiceStart.setAttribute("aria-describedby", "care-voice-disclosure care-voice-status");
    voiceStatus.id = "care-voice-status";
    const voiceCancel = button("Cancel voice input", () => { voice.cancel(); voiceStatus.textContent = "Voice input cancelled. Your draft is unchanged."; }); voiceCancel.hidden = true;
    voice = createVoiceInput({ Recognition: window.SpeechRecognition ?? window.webkitSpeechRecognition,
      onState(phase) {
        const active = phase !== "idle";
        voiceStart.dataset.phase = phase;
        lockControls(active || busy || !!client.pending);
        if (!active && naturalLanguage) modelSubmit.disabled = !consent.checked || busy || !!client.pending;
        voiceStart.textContent = phase === "listening" ? "Stop listening" : phase === "finishing" ? "Finishing…" : "Use voice input";
        voiceStart.disabled = phase === "finishing" || (!active && (busy || !!client.pending));
        voiceCancel.hidden = !active; voiceCancel.disabled = false;
        voiceStatus.textContent = phase === "listening" ? "Listening. Say one short request; nothing will be submitted." : phase === "finishing" ? "Finishing recognition…" : "Voice input stopped. Review your text before continuing.";
      },
      onTranscript(text) {
        try {
          conversationDraft = appendVoiceDraft(input.value, text); input.value = conversationDraft;
          conversationSelection = null; renderSelection();
          clearTransferConsent();
          review.hidden = true; voiceStatus.textContent = "Added to your draft. Check the wording, then press Review request."; input.focus();
        } catch (error) { voiceStatus.textContent = error.message; }
      },
      onError(message) { voiceStatus.textContent = message; },
    });
    voiceStart.disabled = !voice.supported;
    if (!voice.supported) voiceStatus.textContent = "Voice input is unavailable in this browser. You can still type your request.";
    const voiceActions = node("div", null, "care-actions care-voice-actions"); voiceActions.append(voiceStart, voiceCancel);
    input.addEventListener("input", () => {
      conversationDraft = input.value;
      // Changing only the response preserves the deliberately chosen occurrence.
      // Any other wording becomes unbound free text and must resolve unambiguously.
      if (conversationSelection && !input.value.trim().toLowerCase().endsWith(`: ${conversationSelection.title}`.toLowerCase())) conversationSelection = null;
      renderSelection(); review.hidden = true; clearTransferConsent();
    });
    const draftRequest = (value, task) => {
      if (busy || voice?.active || client.pending) return;
      input.value = value; conversationDraft = value; review.hidden = true; clearTransferConsent();
      conversationSelection = { taskId: task.id, title: task.title, dueAt: task.dueAt }; renderSelection();
      reply.textContent = "Your reply is in the draft below. Review it before confirming."; input.focus();
    };
    const prompt = node("section", null, "care-conversation-prompt"), responses = node("div", null, "care-actions care-reply-choices");
    if (currentTask) {
      const taskHeading = node("h3", currentTask.title); taskHeading.id = "care-current-task";
      prompt.setAttribute("aria-labelledby", taskHeading.id);
      prompt.append(node("p", `Next in your plan · ${timestamp(currentTask.dueAt)}`, "kicker"), taskHeading);
      if (currentTask.lastResponse) {
        const lastReply = node("p", [`Last reply: ${currentTask.lastResponse.replaceAll("_", " ")}`, currentTask.confirmedBy,
          currentTask.confirmedAt ? timestamp(currentTask.confirmedAt) : null].filter(Boolean).join(" · "), "care-note");
        lastReply.id = "care-last-response"; prompt.append(lastReply);
      }
      prompt.append(node("p", "Tell Kin how it went. You’ll review before anything is recorded.", "care-note"));
      for (const [command, label] of [["Done", "Done"], ["Not yet", "Not yet"], ["Skip", "Skip today"]]) {
        responses.append(button(label, () => draftRequest(`${command}: ${currentTask.title}`, currentTask)));
      }
    } else {
      prompt.append(node("h3", data.tasks.length ? "No open check-ins." : "Nothing scheduled today."),
        node("p", data.tasks.length ? "You can ask for today’s recorded updates or the weekly brief. A recorded response is not a safety check."
          : "A caregiver can add an agreed-upon check-in in Plan. You can still ask for today’s plan or the weekly brief.", "care-note"));
      const planLink = node("a", "View the plan", "care-conversation-link"); planLink.href = "#plan"; prompt.append(planLink);
    }
    const voicePanel = node("section", null, "care-voice-panel");
    const voiceDisclosure = node("p", "Optional English dictation may send audio to your browser’s speech provider. Kin receives text, not audio. Avoid sensitive details.", "care-note");
    voiceDisclosure.id = "care-voice-disclosure";
    voicePanel.append(voiceActions, node("p", currentTask ? "Say a short update about your check-in, or choose a reply below." : "Try saying “Show today”.", "care-voice-example"), voiceDisclosure, voiceStatus);
    if (currentTask) voicePanel.append(node("p", "Or choose a reply to draft", "care-reply-label"), responses);
    const draft = node("div", null, "care-conversation-draft"), draftNote = node("p", "Type instead, or check the text added by voice. Nothing is recorded yet.", "care-note");
    draftNote.id = "care-draft-note"; draft.append(label, draftNote, selectionNote, input, submit);
    form.append(prompt, voicePanel, draft);
    if (naturalLanguage) {
      const modelOptions = node("details", null, "care-conversation-model"), transfer = node("section", null, "care-transfer"), disclosure = node("label");
      disclosure.htmlFor = consent.id;
      disclosure.append(consent, node("span", "For this request, send my text and today’s open check-in titles and internal task IDs to Amazon Bedrock to suggest a response. Nothing is saved until I separately confirm."));
      transfer.append(disclosure,
        node("p", "Optional · up to 20 attempts per day, at least 10 seconds apart. Failed attempts count too. Consent resets after each attempt or draft edit.", "care-note"), modelSubmit);
      modelOptions.append(node("summary", "More flexible wording with Bedrock (optional)"), transfer); form.append(modelOptions);
    }
    const examples = node("div", null, "care-actions");
    for (const task of openTasks) {
      examples.append(button(`${task.title} · ${timestamp(task.dueAt)}`, () => draftRequest(`Done: ${task.title}`, task)));
    }
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (busy || voice?.active || client.pending || !form.reportValidity()) return;
      const useModel = event.submitter === modelSubmit;
      if (useModel && (!naturalLanguage || !consent.checked)) { reply.textContent = "Read and select the transfer consent for this request first."; return; }
      const transfer = useModel ? { consent: true, version: member.conversation.consentVersion } : undefined;
      const current = ++revision; busy = true; loading = false; lockControls(true); review.hidden = true;
      clearTransferConsent();
      reply.textContent = useModel ? "Asking Bedrock for a suggestion. Nothing is being saved…" : "Checking your request…";
      try {
        const selectedTaskId = useModel ? undefined : conversationSelection?.taskId;
        const result = await (usesMcp ? client.interpretMcp(input.value, transfer, selectedTaskId) : client.interpret(input.value, transfer, selectedTaskId));
        if (current !== revision) return;
        if (result.action === "confirm") {
          const reviewHeading = node("h3", "Review this check-in"); reviewHeading.tabIndex = -1;
          review.replaceChildren(reviewHeading, node("p", result.task.title, "care-review-task"),
            node("p", `Scheduled for ${timestamp(result.task.dueAt)}`, "care-note care-review-time"),
            node("p", `Record as ${result.response.replaceAll("_", " ")} by ${member.name}?`));
          const actions = node("div", null, "care-actions");
          actions.append(button("Confirm this check-in", () => void mutate(() => (usesMcp ? client.confirmViaMcp : client.confirm)({ taskId: result.task.id, response: result.response, actor: member.name, expected: result.expected }), "Check-in recorded.", () => { conversationDraft = ""; conversationSelection = null; }), false),
            button("Leave unchanged", () => { review.hidden = true; reply.textContent = "Left unchanged."; input.focus(); }));
          review.append(actions); review.hidden = false; reply.textContent = result.mode === "bedrock"
            ? "Bedrock suggested this check-in. Check the task and response carefully. Nothing has been saved."
            : "Please review. Nothing has been saved.";
          reviewHeading.focus();
        } else if (result.action === "today" || result.action === "brief") {
          if (!usesMcp) location.hash = result.action === "today" ? "today" : "week";
          else if (result.action === "brief") {
            reply.textContent = result.brief.overview;
            review.replaceChildren(node("h3", result.brief.headline), node("p", "Open Week for the source evidence and printable visit notes.", "care-note")); review.hidden = false;
          } else {
            reply.textContent = `${result.snapshot.summary.completed} of ${result.snapshot.summary.total} check-ins recorded as done today.`;
            const list = node("ul");
            for (const task of result.snapshot.tasks) list.append(node("li", `${task.title} · ${timestamp(task.dueAt)} · ${task.lastResponse?.replaceAll("_", " ") ?? "No response recorded"}`));
            review.replaceChildren(node("h3", "Today’s shared plan"), list); review.hidden = false;
          }
        } else {
          reply.textContent = "I couldn’t match that to one clear check-in. Choose a check-in below, then review your reply. Nothing has changed.";
          help.open = true;
        }
      } catch (error) {
        if (current !== revision) return;
        failure(error); reply.textContent = error.status === 429
          ? "Bedrock requests are limited right now. Choose a reply above, or try later with fresh consent. Your draft is unchanged."
          : error.status === 409 ? "The shared check-in changed while you were reviewing. Review the request again; nothing was saved."
          : useModel ? "Bedrock did not return a usable suggestion. Your draft is still here. Choose a reply above, or consent again to another attempt. No check-in was saved."
          : "Could not review this request. Your draft is still here; try again. Nothing was sent to save.";
      } finally { if (current === revision) { busy = false; lockControls(false); clearTransferConsent(); } }
    });
    const help = node("details", null, "care-conversation-help"); help.id = "care-command-help";
    help.append(node("summary", "What can I say?"), hint, node("h3", "Other check-ins in today’s plan"), examples,
      node("p", openTasks.length ? "Choose a title to draft a Done response. You can change it to Not yet or Skip before review."
        : "There are no open check-ins to choose from.", "care-note"));
    const undoOffer = completionUndoOffer(data);
    content.replaceChildren(heading, ...(undoOffer ? [undoOffer] : []), form, reply, review, help,
      node("p", "Kin shares what your family reports. It cannot verify safety, assess health, or handle emergencies.", "care-note care-conversation-boundary"));
    mcpTracePanel = usesMcp ? node("details", null, "care-mcp-trace") : null;
    if (mcpTracePanel) { content.append(mcpTracePanel); renderMcpTrace(); }
  }
  function renderToday(data) {
    const header = node("div", null, "care-summary");
    const introduction = node("div", null, "care-summary-intro");
    introduction.append(node("p", `Family plan · ${date(data.date)}`, "kicker"), node("h2", "A little care, shared."),
      node("p", data.summary.total ? `${data.summary.completed} of ${data.summary.total} check-ins completed` : "Room for one small check-in.", "care-count"));
    const duty = node("section", null, "care-duty-card");
    duty.setAttribute("aria-label", "Today’s coverage");
    duty.append(node("p", "Today’s coverage", "kicker"),
      node("h3", data.onDuty ? data.onDuty.memberName : "A turn to fill"),
      node("p", data.onDuty ? `${data.onDuty.memberName} is on duty until ${timestamp(data.onDuty.endsAt)}.` : "Nobody is assigned today. A caregiver can arrange coverage in Turns.", "care-note"));
    const dutyLink = node("a", "See family turns", "care-duty-link"); dutyLink.href = "#turns";
    duty.append(dutyLink); header.append(introduction);
    if (member.permissions.confirm) header.append(authorNote());
    const list = node("ul", null, "care-plan");
    for (const task of data.tasks) {
      const item = node("li", null, "care-check-in"), copy = node("div");
      copy.append(node("p", `${timestamp(task.dueAt)} · ${task.state === "closed_unanswered" ? "Closed without a reply" : task.state === "scheduled" ? task.lastResponse === "not_yet" ? "Not yet" : "Awaiting check-in" : task.state}`, "kicker"), node("h3", task.title));
      if (task.state === "closed_unanswered") copy.append(node("p", `Closed by ${task.changedBy ?? "a caregiver"}${task.changedAt ? ` at ${timestamp(task.changedAt)}` : ""}. No reply was recorded.`, "care-note"));
      if (task.confirmedBy) copy.append(node("p", `Via ${task.confirmedBy}’s Kin account · ${timestamp(task.confirmedAt)}`, "care-note"));
      item.append(copy);
      if (member.permissions.confirm && task.state === "scheduled") {
        const actions = node("div", null, "care-actions");
        const expected = { title: task.title, dueAt: task.dueAt, state: task.state, lastResponse: task.lastResponse,
          confirmedAt: task.confirmedAt, confirmedBy: task.confirmedBy };
        for (const [response, label] of [["done", "Done"], ["not_yet", "Not yet"], ["skipped", "Skip today"]]) {
          actions.append(button(label, () => void mutate(() => client.confirm({ taskId: task.id, response, actor: member.name, expected }), "Check-in recorded."), response !== "done"));
        }
        item.append(actions);
      }
      if (canCloseUnanswered(task)) item.append(taskChangeEditor(task, false, true));
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
    if (!data.escalations.length) alerts.append(node("p", "No follow-ups listed for today or yesterday. This is not a safety check."));
    for (const alert of data.escalations) {
      const notification = alert.status === "receipt_pending" ? "Provider accepted; receipt needs review"
        : alert.status === "sent" ? "Notification accepted by the messaging service" : "Notification not confirmed";
      alerts.append(node("p", `${data.tasks.find(task => task.id === alert.taskId)?.title ?? "Check-in"} · Due ${timestamp(alert.dueAt)}. ${notification}${alert.recipientMemberName ? ` for ${alert.recipientMemberName}` : ""}.${alert.acknowledgedBy ? "" : " No caregiver acknowledgment recorded."}`));
      if (alert.status === "receipt_pending") alerts.append(node("p", "The operator needs to reconcile the receipt. This does not prove phone delivery, and Kin will not automatically resend it.", "care-note"));
      if (alert.acknowledgedBy) alerts.append(node("p", `${alert.acknowledgedBy} acknowledged the follow-up at ${timestamp(alert.acknowledgedAt)}. The check-in itself is unchanged.`));
      else if (member.permissions.manageDuty) alerts.append(button("Acknowledge follow-up", () => void mutate(() => client.acknowledge(alert.id), "Follow-up acknowledged.")));
    }
    if (data.escalations.length) alerts.append(node("p", "Acknowledgment records that a caregiver has seen the follow-up. It does not confirm the task is done or cancel queued messages.", "care-note"));
    const undoOffer = completionUndoOffer(data);
    const today = node("div", null, "care-today");
    today.append(header, ...(undoOffer ? [undoOffer] : []), list, duty, alerts);
    content.replaceChildren(today);
  }
  function renderCircle(data) {
    rotationEditor?.destroy(); rotationEditor = null;
    const heading = node("div"); heading.append(node("p", "Seven days of shared care", "kicker"), node("h2", "Who’s taking the next turn?"));
    const days = dutyDays(data), caregivers = data.members.filter(person => person.canReceiveAlerts);
    const covered = days.filter(day => day.assignment).length;
    const coverage = node("p", `${covered} of 7 days assigned${covered < 7 ? ` · ${7 - covered} uncovered` : ""}`, "care-count");
    const zoneNote = typeof data.timeZone === "string" && data.timeZone.trim()
      ? `Duty dates use ${data.timeZone}, your circle’s time zone.`
      : "Circle time zone unavailable. These dates follow the circle’s calendar, not necessarily your phone’s.";
    heading.append(node("p", zoneNote, "care-note"));
    const balance = node("p", caregivers.map(person => {
      const count = days.filter(day => day.assignment?.memberId === person.id).length;
      return `${person.name}: ${count} ${count === 1 ? "day" : "days"}`;
    }).join(" · "), "care-note");
    const roster = node("div", null, "care-roster care-duty-week");
    for (const day of days) {
      const row = node("form", null, "care-roster-row"), label = node("label", date(day.date));
      const select = node("select"); select.id = `duty-${day.date}`; label.htmlFor = select.id;
      const placeholder = new Option(caregivers.length ? "Choose a caregiver" : "No eligible caregivers", ""); placeholder.disabled = true; select.add(placeholder);
      for (const person of caregivers) select.add(new Option(person.name, person.id));
      if (day.assignment) select.add(new Option("Leave this day uncovered", "__clear__"));
      select.value = day.assignment?.memberId ?? ""; select.required = true;
      select.disabled = !member.permissions.manageDuty || (!caregivers.length && !day.assignment);
      const assignedName = data.members.find(person => person.id === day.assignment?.memberId)?.name ?? day.assignment?.memberName;
      const dayCopy = node("div"); dayCopy.append(label, node("p", day.assignment ? `Assigned to ${assignedName}` : "Uncovered", "care-note"));
      if (day.assignment?.changedBy) dayCopy.append(node("p", `Updated by ${day.assignment.changedBy}`, "care-note"));
      row.append(dayCopy, select);
      if (member.permissions.manageDuty && (caregivers.length || day.assignment)) {
        const save = node("button", day.assignment ? "Review handoff" : "Review assignment", "secondary"); save.type = "submit"; row.append(save);
        const review = node("section", null, "duty-review care-alerts"); review.hidden = true; row.append(review);
        select.addEventListener("change", () => { review.hidden = true; });
        row.addEventListener("submit", event => {
          event.preventDefault(); if (busy || client.pending || !row.reportValidity()) return;
          const person = caregivers.find(candidate => candidate.id === select.value);
          const clearing = select.value === "__clear__" && !!day.assignment;
          if (!clearing && (!person || person.id === day.assignment?.memberId)) { status.textContent = "That caregiver is already assigned. Choose someone else for a handoff."; return; }
          const change = { date: day.date, memberId: clearing ? null : person.id, expectedMemberId: day.assignment?.memberId ?? null };
          review.replaceChildren(node("h3", clearing ? "Clear this assignment?" : day.assignment ? "Review the handoff" : "Cover this day"),
            node("p", `${date(day.date)}: ${assignedName ?? "Uncovered"} → ${clearing ? "Uncovered" : person.name}`),
            node("p", zoneNote, "care-note"),
            node("p", clearing ? "Nobody will be assigned for new follow-ups on this day. Alerts already queued keep their original recipient. The change is recorded." : "This changes the day's duty assignment. It does not redirect alerts already queued or confirm notification delivery.", "care-note"));
          const actions = node("div", null, "care-actions");
          const confirm = button(clearing ? "Confirm clear assignment" : "Confirm duty assignment", () => void mutate(() => client.assignDuty(change), clearing ? "Assignment cleared. This day is uncovered." : "Duty assignment saved.", () => {}, "duty"), false);
          actions.append(confirm, button("Keep unchanged", () => { review.hidden = true; select.value = day.assignment?.memberId ?? ""; select.focus(); })); review.append(actions); review.hidden = false; confirm.focus();
        });
      }
      if (member.permissions.manageDuty && (caregivers.length || day.assignment)) {
        const dayPanel = node("details", null, "care-duty-day");
        const summary = node("summary", null, "care-duty-summary");
        const copy = node("span", null, "care-duty-summary-copy");
        copy.append(node("strong", date(day.date)), node("span", day.assignment ? assignedName : "Uncovered", "care-note"));
        summary.append(copy, node("span", day.assignment ? "Change" : "Assign", "care-duty-edit-label"));
        dayPanel.append(summary, row);
        roster.append(dayPanel);
      } else roster.append(row);
    }
    if (!caregivers.length) roster.append(node("p", "No roster member is eligible for duty. The organizer needs to configure the caregiver roster before these days can be assigned."));
    content.replaceChildren(heading, coverage, balance, roster, node("p", "Handoffs apply to new follow-ups; alerts already queued keep their original recipient.", "care-note"));
    if (member.permissions.manageDuty) {
      rotationEditor = renderDutyRotation({ propose: () => client.proposeDutyRotation(), isLocked: () => busy || !!client.pending || !member?.permissions.manageDuty,
        onError: failure, onSave: input => mutate(() => client.acceptDutyRotation(input), "Next week’s rotation saved.", () => {}, "duty") });
      content.append(rotationEditor.element);
    }
    if (member.permissions.manageRoster && data.roster) {
      rosterEditor = renderRosterEditor({ data: data.roster, draft: rosterDraft,
        isLocked: () => busy || !!client.pending || !member?.permissions.manageRoster,
        onMessage: message => { status.textContent = message; },
        onSave: input => mutate(() => client.changeRoster(input), "Circle updated. No account access or alert subscriptions changed.", clearRosterDraft, "roster") });
      content.append(rosterEditor.element);
    }
  }
  function clearRosterDraft() { rosterDraft.clear(); rosterEditor?.clear(); }
  const rescheduleSaved = "Check-in moved. The old Alexa reminder may still sound until cancellation sync finishes. A reminder for the new time requires a fresh, explicit request on Alexa; none was created here.";
  function canCloseUnanswered(task) {
    return member.permissions.closeUnanswered === true && task.state === "scheduled" && task.lastResponse === null &&
      task.confirmedAt === null && task.confirmedBy === null && Date.parse(task.dueAt) < Date.now();
  }
  function taskChangeEditor(task, canReschedule = false, closing = false) {
    const draft = taskChangeDrafts.get(task.id) ?? { title: task.title, action: closing ? "close_unanswered" : "rename", due: "" };
    const details = node("details"), summary = node("summary", closing ? "Close without a reply" : "Edit this check-in");
    const form = node("form", null, "invite-panel"), label = node("label", "Check-in wording");
    const title = node("input"); title.id = `task-title-${task.id}`; title.value = draft.title; title.maxLength = 120; label.htmlFor = title.id;
    const actionLabel = node("label", "Change"), action = node("select"); action.id = `task-action-${task.id}`; actionLabel.htmlFor = action.id;
    if (closing) action.add(new Option("Close without a reply", "close_unanswered"));
    else { action.add(new Option("Rename this check-in", "rename")); action.add(new Option("Cancel this check-in", "cancel")); }
    if (canReschedule) action.add(new Option("Move to a new time", "reschedule"));
    action.value = closing ? "close_unanswered" : draft.action === "reschedule" && !canReschedule ? "rename" : draft.action;
    label.hidden = title.hidden = actionLabel.hidden = action.hidden = closing;
    const dueLabel = node("label", `New time (${Intl.DateTimeFormat().resolvedOptions().timeZone})`), due = node("input");
    due.id = `task-due-${task.id}`; due.type = "datetime-local"; due.value = draft.due ?? ""; dueLabel.htmlFor = due.id;
    const review = node("p", "", "care-note"); review.setAttribute("aria-live", "polite");
    const confirmation = node("label", null, "consent-line"), consent = node("input"); consent.type = "checkbox"; consent.required = true;
    confirmation.append(consent, node("span", closing
      ? `I reviewed “${task.title}”, due ${timestamp(task.dueAt)}. Close it with no reply, not as done or skipped. This cannot be undone here.`
      : `I reviewed this change to “${task.title}”, due ${timestamp(task.dueAt)}. Cancellation keeps a record and cannot be undone here.`));
    function newTime() {
      const value = new Date(due.value);
      const local = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
      if (!Number.isFinite(value.getTime()) || local !== due.value.slice(0, 16)) throw new Error("Choose an available local time.");
      if (value.getTime() === Date.parse(task.dueAt) || value <= new Date() || value > new Date(Date.now() + 30 * 86400000)) throw new Error("Choose a different future time within the next 30 days.");
      return value.toISOString();
    }
    function updateReview() {
      const moving = action.value === "reschedule";
      title.disabled = action.value !== "rename"; title.required = action.value === "rename";
      due.hidden = dueLabel.hidden = !moving; due.disabled = !moving; due.required = moving;
      if (closing) { review.textContent = "Records who closed this overdue check-in and when. It will no longer qualify for a new missed-check-in alert. This does not retract queued notifications or verify anyone’s safety."; return; }
      if (!moving) { review.textContent = "Only this future, unanswered check-in will change. Its scheduled time stays the same."; return; }
      let when = "Choose the new time above.";
      try { when = `New time: ${timestamp(newTime())}.`; } catch (error) { when = error.message; }
      review.textContent = `Old time: ${timestamp(task.dueAt)}. ${when} Moving cancels the old check-in and creates a new one with the same wording. The old Alexa reminder may still sound until cancellation sync finishes. A reminder for the new time needs a fresh, explicit request on Alexa; this does not create one or retract queued caregiver alerts.`;
    }
    const remember = () => {
      taskChangeDrafts.set(task.id, { title: title.value.slice(0, 120), action: action.value, due: due.value });
      consent.checked = false; updateReview();
    };
    title.addEventListener("input", remember); title.addEventListener("change", remember);
    due.addEventListener("input", remember); due.addEventListener("change", remember);
    action.addEventListener("change", remember); updateReview();
    const save = node("button", "Apply reviewed change", "secondary"); save.type = "submit";
    form.append(node("p", closing ? "No reply has been recorded for this overdue check-in. Closing it preserves that fact in your family history."
      : "Your wording, action, and new time stay while switching Kin tabs; always review again before saving.", "care-note"), label, title, actionLabel, action, dueLabel, due, review, confirmation, save);
    form.addEventListener("submit", event => {
      event.preventDefault(); if (busy || client.pending || !consent.checked || !form.reportValidity()) return;
      consent.checked = false;
      let dueAt;
      if (action.value === "reschedule") {
        if (!canReschedule) return;
        try { dueAt = newTime(); } catch (error) { status.textContent = error.message; due.focus(); return; }
      }
      void mutate(() => client.changeTask({ taskId: task.id, action: action.value, ...(action.value === "rename" ? { title: title.value.trim() } : {}),
        ...(dueAt ? { dueAt } : {}), expected: { title: task.title, dueAt: task.dueAt }, confirm: true }), dueAt ? rescheduleSaved : "Check-in updated.", () => taskChangeDrafts.delete(task.id));
    });
    details.append(summary, form); return details;
  }
  function renderPlan(data) {
    pauseEditor?.destroy(); pauseEditor = null;
    const heading = node("div"); heading.append(node("p", data.historyDays === 30 ? "Recent check-ins and the next 30 days" : "The next 30 days", "kicker"), node("h2", "Your family’s plan."), node("p", "Agree on an ordinary check-in, once or as a short daily routine. This is care coordination, not a medication recommendation."));
    const form = node("form", null, "invite-panel care-plan-create");
    form.setAttribute("aria-label", "Schedule a check-in");
    if (member.permissions.manageDuty) {
      form.append(node("h3", "Add a check-in."));
      const draft = planDraft.read();
      const titleLabel = node("label", "What is the check-in?"); titleLabel.htmlFor = "plan-title";
      const title = node("input"); title.id = "plan-title"; title.required = true; title.maxLength = 120; title.placeholder = "A glass of water, a walk, a call…";
      title.value = draft.title;
      const add = node("button", "Add a check-in", "secondary"); add.id = "plan-add-shortcut"; add.type = "button";
      add.addEventListener("click", () => title.focus());
      const actions = node("div", null, "care-plan-actions"); actions.append(add); heading.append(actions);
      const dueLabel = node("label", `When? (${Intl.DateTimeFormat().resolvedOptions().timeZone})`); dueLabel.htmlFor = "plan-due";
      const due = node("input"); due.id = "plan-due"; due.type = "datetime-local"; due.required = true;
      due.value = draft.due;
      const repeatLabel = node("label", "How often?"); repeatLabel.htmlFor = "plan-repeat";
      const repeat = node("select"); repeat.id = "plan-repeat";
      for (const [value, label] of [["1", "Just once"], ["7", "Daily · 7 check-ins"], ["14", "Daily · 14 check-ins"]]) repeat.add(new Option(label, value));
      repeat.value = draft.repeat;
      const remember = () => planDraft.update({ title: title.value, due: due.value, repeat: repeat.value });
      for (const field of [title, due, repeat]) { field.addEventListener("input", remember); field.addEventListener("change", remember); }
      const preview = node("p", "", "care-note care-plan-preview"); preview.setAttribute("role", "status");
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
        try { const times = occurrences(); preview.textContent = `${times.length} check-in${times.length === 1 ? "" : "s"} · ${timestamp(times[0])}${times.length > 1 ? ` through ${timestamp(times.at(-1))}. Stops after the last check-in; it does not renew.` : ""}`; }
        catch (error) { preview.textContent = error.message; }
      }
      due.addEventListener("change", updatePreview); repeat.addEventListener("change", updatePreview); updatePreview();
      const submit = node("button", "Save care plan", "primary"); submit.type = "submit";
      const timeNote = node("p", "Keep every check-in within the next 30 days.", "care-note care-plan-time-note");
      timeNote.id = "plan-time-note"; due.setAttribute("aria-describedby", timeNote.id);
      const alertNote = node("p", "Missed check-ins may notify the caregiver on duty.", "care-note care-plan-notification-note");
      alertNote.id = "plan-notification-note";
      const draftNote = node("p", "Your draft stays while switching Kin tabs. Reloading this page or closing the session clears it.", "care-note care-plan-draft-note");
      draftNote.id = "plan-draft-note";
      const editingHelp = node("details", null, "care-plan-editing-help"); editingHelp.id = "plan-editing-help";
      editingHelp.append(node("summary", "Changing a plan later"),
        node("p", `You can rename or cancel future, untouched check-ins below. ${data.features?.reschedule === true ? "A one-time check-in can also move to a new time. For a routine, cancel its future check-ins and schedule a new routine." : "To change a time, cancel the old check-in or routine and schedule a new one."}`, "care-note"));
      form.append(titleLabel, title, dueLabel, due, timeNote, repeatLabel, repeat, preview, alertNote, submit, draftNote, editingHelp);
      form.addEventListener("submit", event => {
        event.preventDefault(); if (!form.reportValidity()) return;
        const when = new Date(due.value);
        if (!Number.isFinite(when.getTime()) || when <= new Date() || when > new Date(Date.now() + 30 * 86400000)) { status.textContent = "Choose a future time within the next 30 days."; due.focus(); return; }
        let dueAts;
        try { dueAts = occurrences(); } catch (error) { status.textContent = error.message; due.focus(); return; }
        if (new Date(dueAts.at(-1)) > new Date(Date.now() + 30 * 86400000)) { status.textContent = "The entire routine must fit within the next 30 days."; due.focus(); return; }
        const input = dueAts.length === 1 ? { title: title.value.trim(), dueAt: dueAts[0] }
          : { title: title.value.trim(), dueAts, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
        void mutate(() => client.schedule(input), "Care plan saved.", clearPlanDraft);
      });
    } else form.append(node("p", "Your role can view the plan. A caregiver can schedule new check-ins."));
    const now = Date.now();
    const upcomingTasks = data.tasks.filter(task => task.state === "scheduled" && Date.parse(task.dueAt) > now)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
    const earlierTasks = data.tasks.filter(task => task.state === "scheduled" && Date.parse(task.dueAt) <= now)
      .sort((a, b) => Date.parse(b.dueAt) - Date.parse(a.dueAt));
    const recordedTasks = data.tasks.filter(task => task.state !== "scheduled")
      .sort((a, b) => Date.parse(b.dueAt) - Date.parse(a.dueAt));
    function planRows(tasks) {
      const list = node("ul", null, "care-plan");
      for (const task of tasks) {
        const row = node("li"), copy = node("div"); copy.append(node("h3", task.title), node("p", `${timestamp(task.dueAt)} · ${task.state === "closed_unanswered" ? "Closed without a reply" : task.state}`, "care-note"));
        if (canCloseUnanswered(task)) copy.append(taskChangeEditor(task, false, true));
        if (task.state === "closed_unanswered") copy.append(node("p", `Closed by ${task.changedBy ?? "a caregiver"}${task.changedAt ? ` at ${timestamp(task.changedAt)}` : ""}. No reply was recorded.`, "care-note"));
        if (member.permissions.manageDuty && !task.routineId && task.state === "scheduled" && task.lastResponse === null &&
            task.confirmedAt === null && task.confirmedBy === null && new Date(task.dueAt) > new Date()) copy.append(taskChangeEditor(task, data.features?.reschedule === true));
        if (task.rescheduledFrom) {
          const reminderNote = task.state === "scheduled" && Date.parse(task.dueAt) > now
            ? " A new Alexa reminder requires a fresh request." : "";
          copy.append(node("p", `Moved from ${timestamp(task.rescheduledFrom.dueAt)}.${reminderNote}`, "care-note"));
        }
        if (task.rescheduledTo) copy.append(node("p", `Moved to ${timestamp(task.rescheduledTo.dueAt)}; this original check-in is cancelled.`, "care-note"));
        row.append(copy); list.append(row);
      }
      return list;
    }
    const upcoming = node("section", null, "care-plan-group"); upcoming.id = "plan-upcoming";
    upcoming.setAttribute("aria-label", "Coming up");
    upcoming.append(node("h3", `Coming up · ${upcomingTasks.length}`, "care-plan-group-title"));
    if (upcomingTasks.length) {
      upcoming.append(planRows(upcomingTasks.slice(0, 3)));
      if (upcomingTasks.length > 3) {
        const more = node("details", null, "care-plan-more"); more.id = "plan-upcoming-more";
        const remaining = upcomingTasks.length - 3;
        more.append(node("summary", `Show ${remaining} more upcoming check-in${remaining === 1 ? "" : "s"}`), planRows(upcomingTasks.slice(3)));
        upcoming.append(more);
      }
    }
    else upcoming.append(node("p", member.permissions.manageDuty
      ? data.tasks.length ? "No upcoming check-ins. Add one below when your family is ready." : "Your plan is empty. Start with one small, agreed-upon check-in."
      : "No upcoming check-ins. A caregiver can schedule an agreed-upon check-in.", "care-note"));
    const earlier = node("section", null, "care-plan-group"); earlier.id = "plan-earlier";
    earlier.setAttribute("aria-label", "Earlier, still open");
    earlier.append(node("h3", `Earlier, still open · ${earlierTasks.length}`, "care-plan-group-title"),
      node("p", "Their scheduled time has passed, but no completion, skip or closure is recorded. This does not tell you whether someone is safe.", "care-note"));
    const recentEarlierTasks = earlierTasks.slice(0, 3), olderTasks = earlierTasks.slice(3);
    if (olderTasks.length) earlier.append(node("p", `Showing the 3 most recent of ${earlierTasks.length} open check-ins. Older entries remain available below.`, "care-note"));
    earlier.append(planRows(recentEarlierTasks));
    if (olderTasks.length) {
      const more = node("details", null, "care-plan-more"); more.id = "plan-earlier-more";
      more.append(node("summary", `Show ${olderTasks.length} older open check-in${olderTasks.length === 1 ? "" : "s"}`), planRows(olderTasks));
      earlier.append(more);
    }
    const recorded = node("details", null, "care-plan-group care-plan-history"); recorded.id = "plan-history";
    recorded.append(node("summary", `Recorded outcomes · ${recordedTasks.length}`),
      node("p", "Completed, skipped, cancelled and closed check-ins in this loaded plan. Most recent scheduled time first.", "care-note"), planRows(recordedTasks));
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
        title.addEventListener("input", () => { consent.checked = false; });
        title.addEventListener("change", () => { consent.checked = false; });
        confirmation.append(consent, node("span", `I reviewed this change to ${tasks.length} future check-ins. Cancellation keeps a record; it cannot be undone here.`));
        const save = node("button", "Apply reviewed change", "secondary"); save.type = "submit";
        edit.append(node("p", `${timestamp(tasks[0].dueAt)} through ${timestamp(tasks.at(-1).dueAt)}`, "care-note"), label, title, actionLabel, action, confirmation, save);
        edit.addEventListener("submit", event => { event.preventDefault(); if (busy || client.pending || !consent.checked || !edit.reportValidity()) return;
          consent.checked = false;
          void mutate(() => client.changeRoutine({ routineId, action: action.value, ...(action.value === "rename" ? { title: title.value.trim() } : {}),
            expected: tasks.map(({ id, title, dueAt }) => ({ id, title, dueAt })), confirm: true }), "Routine updated.");
        });
        details.append(summary, edit); routines.append(details);
      }
    }
    if ((member.permissions.pausePlan && data.features?.planPause === true) || data.planPause?.pause) {
      pauseEditor = renderPlanPause({ control: data.planPause, enabled: member.permissions.pausePlan === true && data.features?.planPause === true,
        propose: () => client.proposePlanPause(), isLocked: () => busy || !!client.pending || !member?.permissions.pausePlan,
        onError: failure, onSave: proposal => mutate(() => client.pausePlan(proposal), pauseSavedMessage, () => {}, "pause") });
    }
    const activePause = data.planPause?.pause && new Date(data.planPause.pause.endsAt) > new Date();
    content.replaceChildren(heading, ...(pauseEditor && activePause ? [pauseEditor.element] : []), upcoming, form, routines,
      ...(earlierTasks.length ? [earlier] : []), ...(recordedTasks.length ? [recorded] : []),
      ...(pauseEditor && !activePause ? [pauseEditor.element] : []));
  }
  function renderBrief(data) {
    restorePrintedEvidence(); briefCitationGroups = [];
    let returnCitation = null;
    const title = node("h2", data.headline); title.setAttribute("tabindex", "-1");
    const evidence = node("details", null, "care-brief-evidence"); briefEvidence = evidence;
    evidence.append(node("summary", `Based on ${data.evidence.length} recorded event${data.evidence.length === 1 ? "" : "s"}`));
    const sources = new Map();
    for (const [index, fact] of data.evidence.entries()) {
      const item = node("section", null, "care-brief-source"); item.id = `brief-source-${index + 1}`; item.setAttribute("tabindex", "-1");
      item.append(node("h3", `Source ${index + 1}`), node("p", fact.fact),
        node("p", `${fact.kind === "care_task" ? "Check-in due" : "Related check-in due"} · ${timestamp(fact.occurredAt)}`, "care-note"),
        node("code", fact.id, "care-source-id"));
      const back = button("Back to summary", () => {
        const target = returnCitation ?? title;
        target.focus(); target.scrollIntoView({ block: "center" });
      });
      back.classList.add("care-source-return", "no-print"); item.append(back);
      evidence.append(item); sources.set(fact.id, { number: index + 1, element: item });
    }
    if (!data.evidence.length) evidence.append(node("p", "No source records were returned for this period.", "care-note"));
    function references(ids = []) {
      const links = node("div", null, "care-source-links");
      let unavailable = false, count = 0;
      for (const id of new Set(ids)) {
        const source = sources.get(id);
        if (!source) { unavailable = true; continue; }
        count += 1;
        const link = button(`Source ${source.number}`, () => {
          returnCitation = link;
          evidence.open = true; source.element.focus(); source.element.scrollIntoView({ block: "nearest" });
        });
        link.classList.add("care-source-link"); link.setAttribute("aria-controls", source.element.id); links.append(link);
      }
      const result = node("div");
      if (count > 3) {
        const group = node("details", null, "care-source-group");
        group.append(node("summary", `View ${count} sources`), links);
        briefCitationGroups.push(group); result.append(group);
      } else result.append(links);
      if (unavailable) result.append(node("p", "A source for this point is unavailable.", "care-note"));
      return result;
    }
    const heading = node("div", null, "care-brief-heading"); heading.append(node("p", `${date(data.period.startDate)} – ${date(data.period.endDate)}`, "kicker"), title, node("p", data.overview));
    heading.append(references(data.overviewEvidenceIds));
    const facts = node("p", `${data.stats.completed} completed · ${data.stats.skipped} skipped · ${data.stats.stillOpen} still open${data.stats.closedUnanswered ? ` · ${data.stats.closedUnanswered} closed without a reply` : ""}`, "care-count");
    const points = node("div", null, "care-brief-sections");
    for (const [title, rows] of [["For your next conversation", data.followUps], ["What stood out", data.highlights]]) {
      const section = node("section", null, "care-brief-section");
      section.append(node("h3", title)); const list = node("ul");
      for (const point of rows) { const item = node("li"); item.append(node("p", point.text), references(point.evidenceIds)); list.append(item); }
      if (!rows.length) list.append(node("li", "No additional points in the recorded activity.")); section.append(list); points.append(section);
    }
    if (data.patterns) {
      const section = node("section", null, "care-brief-section");
      section.append(node("h3", "Patterns in recorded replies"));
      const list = node("ul");
      for (const point of data.patterns.points) { const item = node("li"); item.append(node("p", point.text), references(point.evidenceIds)); list.append(item); }
      section.append(list, node("p", data.patterns.notice, "care-note")); points.append(section);
    }
    if (data.responsibility) {
      const section = node("section", null, "care-brief-section");
      section.append(node("h3", "Sharing the follow-up"));
      const list = node("ul");
      for (const point of data.responsibility.points) { const item = node("li"); item.append(node("p", point.text), references(point.evidenceIds)); list.append(item); }
      if (!data.responsibility.points.length) list.append(node("li", "No follow-up sharing summary is available for this period."));
      section.append(list, node("p", data.responsibility.notice, "care-note")); points.append(section);
    }
    const print = button("Print visit notes", () => window.print()); print.classList.add("no-print");
    content.replaceChildren(heading, facts, points, evidence, node("p", data.generatedBy === "bedrock" ? "Evidence selected with Amazon Bedrock; wording comes from recorded facts." : "Prepared directly from recorded activity; no generated interpretation.", "care-note"), node("p", data.safetyNotice, "care-note"), print);
  }
  function restorePrintedEvidence() {
    if (printedEvidence) {
      for (const { element, wasOpen } of printedEvidence) element.open = wasOpen;
      printedEvidence = null;
    }
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
    if (!member || voice?.active || (busy && !afterWrite) || (!afterWrite && client.undoReviewing) || loading || tab() === "invite") return;
    loading = true; const current = revision, view = tab();
    if (!content.childElementCount) { status.textContent = "Loading your family’s update…"; renderLoading(view); }
    try {
      const identity = await client.session();
      if (current !== revision || view !== tab() || voice?.active) return;
      // Do not keep organizer controls alive while a later data read fails.
      if (!identity.permissions.manageRoster && rosterEditor) {
        clearRosterDraft(); rosterEditor.element.remove(); rosterEditor = null; member = identity; lastRender = "";
      }
      if (!identity.permissions.manageDuty && rotationEditor) {
        rotationEditor.destroy(); rotationEditor.element.remove(); rotationEditor = null; member = identity; lastRender = "";
      }
      if (!identity.permissions.pausePlan && pauseEditor) {
        pauseEditor.destroy(); pauseEditor.element.remove(); pauseEditor = null; member = identity; lastRender = "";
      }
      const data = await (view === "plan" ? client.plan() : view === "access" ? client.access() : view === "week" ? client.brief()
        : isTurns(view) ? identity.permissions.manageRoster
          ? Promise.all([client.circle(), client.roster()]).then(([circle, roster]) => ({ ...circle, roster }))
          : client.circle()
        : client.today());
      if (current !== revision || view !== tab() || voice?.active) return;
      member = identity;
      syncNavigation();
      if (!member.permissions.manageDuty) { planDraft.clear(); taskChangeDrafts.clear(); }
      if (!member.permissions.manageRoster) { rosterDraft.clear(); rosterEditor = null; }
      const serialized = JSON.stringify({ view, data, member, undo: ["today", "ask"].includes(view) ? client.undoOffer(data) : null });
      if (serialized !== lastRender || afterWrite) {
        (view === "ask" ? renderConversation : view === "plan" ? renderPlan : view === "access" ? renderAccess : view === "week" ? renderBrief : isTurns(view) ? renderCircle : renderToday)(data);
        lastRender = serialized;
      }
      status.textContent = `Checked at ${time(new Date())}${view === "today" ? " · checks about every 5 seconds while this tab is visible" : ""}.`;
      if (client.pending) lockControls(true);
      return true;
    } catch (error) { if (current === revision) failure(error); }
    finally { if (current === revision) { loading = false; loadingPanel = null; content.removeAttribute("aria-busy"); } }
  }
  async function navigate({ focus = false } = {}) {
    if (!member) return;
    // A native accessibility anchor changes focus, not the selected family view.
    // On a fresh session at this anchor, still initialize the default Today view.
    if (location.hash === "#workspace-main" && activeView !== null) return;
    if (busy || client.pending) { history.replaceState(null, "", `#${activeView}`); status.textContent = "Finish or retry the current change before switching views."; return; }
    pauseEditor?.destroy(); pauseEditor = null;
    client.cancelUndoReview(); clearTimeout(undoReviewTimer);
    voice?.cancel(); voice = null;
    mcpTracePanel = null;
    rotationEditor?.destroy(); rotationEditor = null;
    restorePrintedEvidence(); briefEvidence = null; briefCitationGroups = [];
    revision += 1; loading = false; loadingPanel = null; content.removeAttribute("aria-busy"); content.replaceChildren(); lastRender = "";
    const view = tab();
    activeView = view;
    const management = $("workspace-management");
    if (management) management.open = ["invite", "access"].includes(view);
    if (view !== "invite") onLeaveInvite();
    $("invite-status").textContent = ""; $("invite-reload").hidden = true;
    $("workspace").hidden = view === "invite"; $("invitation-area").hidden = view !== "invite";
    document.querySelectorAll("#workspace-nav a, #workspace-secondary a").forEach(link => { if (link.hash === `#${isTurns(view) ? "turns" : view}`) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); });
    if (view === "invite") { await onInvite(); return; }
    const current = revision;
    await refresh();
    if (focus && member && current === revision && view === tab()) content.focus();
  }
  async function poll(generation) {
    if (!member || generation !== sessionGeneration) return;
    if (!document.hidden && tab() === "today") await refresh();
    if (member && generation === sessionGeneration) timer = setTimeout(() => poll(generation), 5000);
  }
  // Keep a signed-out parent deep link intact for the subsequent sign-in flow.
  $("workspace-skip")?.addEventListener("click", event => { event.preventDefault(); $("workspace-main")?.focus(); });
  $("workspace-refresh").addEventListener("click", () => {
    if (!busy && !client.pending && client.undoReviewing) { client.cancelUndoReview(); clearTimeout(undoReviewTimer); lastRender = ""; }
    void refresh();
  });
  $("workspace-retry-write").addEventListener("click", () => {
    const kind = client.pendingKind, taskId = client.pending?.taskId, moving = client.pending?.action === "reschedule";
    if (kind === "plan pause") { void mutate(() => client.retry(), pauseSavedMessage, () => {}, "pause"); return; }
    if (kind === "completion undo") {
      void mutate(() => client.retry(), "Completion undone. The earlier response was restored; canceled reminders stay canceled.", () => { clearTimeout(undoReviewTimer); }, "undo"); return;
    }
    void mutate(() => client.retry(), kind === "weekly rotation" ? "Next week’s rotation saved." : kind === "circle change" ? "Circle updated. No account access or alert subscriptions changed." : kind === "duty handoff" ? "Duty assignment saved." : kind === "care plan" ? "Care plan saved." : kind === "routine change" ? "Routine updated." : kind === "check-in change" ? moving ? rescheduleSaved : "Check-in updated." : "Check-in recorded.",
      () => { if (kind === "check-in") { conversationDraft = ""; conversationSelection = null; } if (kind === "care plan") clearPlanDraft(); if (kind === "circle change") clearRosterDraft(); if (kind === "check-in change") taskChangeDrafts.delete(taskId); }, kind === "circle change" ? "roster" : kind === "duty handoff" || kind === "weekly rotation" ? "duty" : "plan");
  });
  window.addEventListener("hashchange", () => void navigate({ focus: true }));
  window.addEventListener("beforeprint", () => {
    if (!member || activeView !== "week" || !briefEvidence || printedEvidence) return;
    printedEvidence = [briefEvidence, ...briefCitationGroups].map(element => ({ element, wasOpen: element.open }));
    for (const { element } of printedEvidence) element.open = true;
  });
  window.addEventListener("afterprint", restorePrintedEvidence);
  document.addEventListener("visibilitychange", () => { if (document.hidden) voice?.cancel(); else void refresh(); });
  window.addEventListener("pagehide", () => voice?.cancel());
  return { reset, async open() {
    reset(); const current = revision, generation = sessionGeneration;
    try {
      const identity = await client.session(); if (current !== revision) return;
      member = identity; $("workspace-identity").textContent = `${member.name} · ${member.permissions.invite ? "organizer" : member.role.replaceAll("_", " ")}`;
      pushControls.open(member.push);
      document.querySelector("main").classList.add("workspace-ready");
      $("workspace-navigation").hidden = false; $("workspace-nav").hidden = false; syncNavigation();
      await navigate();
      if (member && generation === sessionGeneration) timer = setTimeout(() => poll(generation), 5000);
    } catch (error) { failure(error); if (!error.stale && ![401, 403].includes(error.status)) onAccessLost(0); }
  } };
}
