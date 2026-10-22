import { createMcpCareClient } from "./mcp-client.js";
import { createConfirmationSender } from "./care-client.js";
import { appendVoiceDraft, createVoiceInput } from "./voice-input.js";

// The server owns care state. Drafts, transcript and transport evidence live only in this page.
export function createStoryPage({ doc = document, request = (...args) => fetch(...args),
  makeMcp = onTrace => createMcpCareClient(new URL("/mcp", location.origin), { onTrace }), newRequestId,
  Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition } = {}) {
  const $ = id => doc.getElementById(id);
  const node = (tag, text, className) => { const item = doc.createElement(tag); if (text != null) item.textContent = text; if (className) item.className = className; return item; };
  let ready = false, busy = false, disposed = false, suspended = false, reading = false, readRevision = 0, lifecycle = 0, timer;
  let operation = Promise.resolve();
  const active = () => !disposed && !suspended;
  const owns = owner => active() && owner === lifecycle;
  const stale = () => Object.assign(new Error("Story page changed"), { stale: true });
  let story, parentSnapshot, caregiverSnapshot, mcp, proposal = null, pendingRest = null, contextToken;
  let voicePhase = "idle";
  const transcript = [], evidence = [];
  const sender = createConfirmationSender({ newRequestId, send: input => mcpCall(connection => connection.confirm(input)) });
  const pending = () => !!sender.pending || !!pendingRest;
  const voice = createVoiceInput({ Recognition,
    onState(phase) {
      voicePhase = phase;
      if (!active()) return;
      $("story-voice-status").textContent = phase === "listening" ? "Listening… Stop to finish your draft, or cancel to discard this recording."
        : phase === "finishing" ? "Finishing dictation… You can still cancel. Nothing has been sent to Kin."
        : "Dictation ended. Review your draft before sending it.";
      controls();
    },
    onTranscript(text) {
      if (!active() || !ready || doc.visibilityState === "hidden") return;
      try {
        const draft = appendVoiceDraft($("story-message").value, text);
        draftChanged(); $("story-message").value = draft;
        $("story-voice-status").textContent = "Words added to your draft. Edit them, then choose Review request. Nothing was saved.";
      } catch (error) { $("story-voice-status").textContent = error.message; }
      $("story-message").focus();
    },
    onError(message) { if (active()) { $("story-voice-status").textContent = message; $("story-message").focus(); } },
  });
  const formatTime = value => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: story.timeZone }).format(new Date(value));
  const formatTimestamp = value => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: story.timeZone }).format(new Date(value));
  const responseLabel = task => task.state === "scheduled" ? task.lastResponse === "not_yet" ? "Not yet" : "Awaiting a reply" : task.state === "done" ? "Done" : task.state === "skipped" ? "Skipped" : task.state;
  function setStatus(message) { $("story-status").textContent = message; }
  function controls() {
    const locked = !ready || busy || pending() || voice.active || !active();
    $("story-app").querySelectorAll("button, textarea, input").forEach(button => { button.disabled = locked; });
    $("story-confirm").disabled = locked || !proposal;
    $("story-advance").disabled = locked || story?.step === "after_grace";
    $("story-retry").hidden = !pending();
    $("story-retry").disabled = !ready || busy || voice.active || !active();
    $("story-retry").textContent = sender.pending ? "Retry the same check-in" : pendingRest?.kind === "advance" ? "Retry the same clock advance" : "Retry the same caregiver acknowledgment";
    $("story-voice-start").disabled = locked || !voice.supported;
    $("story-voice-start").hidden = voice.active;
    $("story-voice-stop").hidden = !voice.active; $("story-voice-cancel").hidden = !voice.active;
    $("story-voice-stop").disabled = !active() || voicePhase !== "listening";
    $("story-voice-cancel").disabled = !active() || !voice.active;
    const capability = story?.conversation;
    $("story-model-options").hidden = capability?.mode !== "bedrock";
    $("story-model-consent").disabled = locked || capability?.mode !== "bedrock" || capability.modelRequests >= capability.modelLimit;
    $("story-submit").textContent = busy ? "Reviewing…" : $("story-model-consent").checked ? "Review with Nova" : "Review request";
    if (capability) $("story-model-budget").textContent = `${capability.modelRequests} of ${capability.modelLimit} model requests used in this server session. Failed attempts also count.`;
  }
  function unavailable() {
    ready = false; readRevision += 1; voice.cancel();
    $("story-app").hidden = true; $("story-unavailable").hidden = false;
    $("story-unavailable-heading").textContent = "Start local story server";
    $("story-unavailable-copy").textContent = "This page only works with Kin’s isolated local story server. Start that server, then try again. No live family service will be used.";
    $("story-reconnect").hidden = false; controls();
  }
  async function json(url, options = {}) {
    const owner = lifecycle;
    if (!owns(owner)) throw stale();
    const result = await request(url, { cache: "no-store", signal: AbortSignal.timeout(8000), ...options });
    if (!owns(owner)) throw stale();
    if (!result.ok) {
      let detail;
      try { detail = await result.json(); } catch { /* Failure bodies need not be JSON. */ }
      if (!owns(owner)) throw stale();
      throw Object.assign(new Error("Local request unavailable"), { status: result.status, code: detail?.error, modelRequests: detail?.modelRequests });
    }
    const value = await result.json();
    if (!owns(owner)) throw stale();
    return value;
  }
  async function mcpCall(action) {
    const owner = lifecycle;
    if (!owns(owner)) throw stale();
    const value = await action(mcp);
    if (!owns(owner)) throw stale();
    return value;
  }
  async function readStory() {
    const owner = lifecycle, revision = readRevision;
    try {
      const value = await json("/demo/story");
      if (value.mode !== "local-story" || value.timeZone !== "America/Denver" || !["check_in", "after_grace"].includes(value.step)
        || !Number.isFinite(Date.parse(value.now)) || value.graceMinutes !== 30 || !Array.isArray(value.notifications)
        || value.notifications.some(item => item.status !== "simulated") || !["limited", "bedrock"].includes(value.conversation?.mode)
        || value.conversation.modelLimit !== 20 || !Number.isInteger(value.conversation.modelRequests)
        || value.conversation.modelRequests < 0 || value.conversation.modelRequests > 20) throw new Error("Not a local story server");
      return value;
    } catch (error) {
      // An obsolete poll must not close a newer, successfully refreshed view.
      if (owns(owner) && revision === readRevision) unavailable();
      throw error;
    }
  }
  function renderClock() {
    $("story-clock").textContent = formatTimestamp(story.now);
    $("story-step").textContent = story.step === "after_grace"
      ? "The clock is at 9:31 AM. Follow-ups below reflect the server’s sweep, not a real notification delivery."
      : "Start with Show today, then record Not yet. The server gives that reply a 30-minute grace period.";
    $("story-dialogue-mode").textContent = story.conversation.mode === "bedrock"
      ? "Simple check-in replies work locally. More flexible wording is available with optional Nova consent. Every check-in still needs your review."
      : "Simple check-in replies are understood locally; uncertain wording needs clarification. Dictation only fills the draft. No language model is connected.";
  }
  function addTranscript(speaker, text) {
    transcript.push({ speaker, text: String(text).slice(0, 1400) });
    if (transcript.length > 16) transcript.splice(0, transcript.length - 16);
    $("story-transcript").replaceChildren(...transcript.map(entry => {
      const item = node("li"); item.dataset.speaker = entry.speaker;
      item.append(node("strong", entry.speaker === "Kin" ? "Kin · local demo reply" : "Evelyn · submitted draft"), node("p", entry.text)); return item;
    }));
    $("story-transcript").scrollTop = $("story-transcript").scrollHeight;
  }
  function onTrace(event) {
    if (!active() || !["request", "result", "error"].includes(event.phase)) return;
    const parts = [`${String(event.tool).slice(0, 80)} · ${event.phase}`];
    if (typeof event.rpcId === "string" || typeof event.rpcId === "number") parts.push(`RPC ${String(event.rpcId).slice(0, 80)}`);
    if (typeof event.requestId === "string") parts.push(`receipt ${event.requestId.slice(0, 100)}`);
    if (Number.isFinite(event.durationMs)) parts.push(`${Math.round(event.durationMs)} ms local round trip`);
    if (event.errorCode) parts.push(String(event.errorCode).slice(0, 80));
    if (event.result?.response) parts.push(`reply: ${event.result.response.replaceAll("_", " ")}`);
    if (Number.isFinite(event.result?.completed) && Number.isFinite(event.result?.total)) parts.push(`${event.result.completed}/${event.result.total} completed`);
    if (event.result?.generatedBy) parts.push(`brief: ${event.result.generatedBy}`);
    evidence.push(parts.join(" · "));
    if (evidence.length > 12) evidence.splice(0, evidence.length - 12);
    $("story-evidence-list").replaceChildren(...evidence.map(text => node("li", text)));
    $("story-evidence-count").textContent = `${evidence.length} events`;
  }
  function renderParent() {
    const task = parentSnapshot.tasks.find(item => item.state === "scheduled") ?? parentSnapshot.tasks[0];
    const target = $("story-parent-plan");
    if (!task) { target.replaceChildren(node("p", "No check-ins are scheduled for today.")); return; }
    target.replaceChildren(node("strong", task.title), node("p", `Due ${formatTime(task.dueAt)} · ${responseLabel(task)}`));
    if (task.confirmedBy && task.confirmedAt) target.append(node("p", `${task.confirmedBy} reported this at ${formatTime(task.confirmedAt)}.`, "story-note"));
  }
  function renderCaregiver() {
    const data = caregiverSnapshot;
    $("story-duty").textContent = data.onDuty ? `${data.onDuty.memberName} is on duty until ${formatTime(data.onDuty.endsAt)}.` : "Nobody is assigned to this turn.";
    $("story-care-plan").replaceChildren(...data.tasks.map(task => {
      const item = node("li"); item.append(node("p", `Due ${formatTime(task.dueAt)}`), node("h3", task.title), node("p", responseLabel(task), "story-task-response"));
      if (task.confirmedBy && task.confirmedAt) item.append(node("p", `Reported by ${task.confirmedBy} at ${formatTime(task.confirmedAt)}.`));
      return item;
    }));
    if (!data.tasks.length) $("story-care-plan").append(node("li", "No check-ins are scheduled today."));
    const alerts = data.escalations ?? [];
    $("story-alerts").replaceChildren(...alerts.map(alert => {
      const item = node("div", null, "story-alert");
      const notification = story.notifications.find(record => record.id === alert.id);
      item.append(node("p", `${data.tasks.find(task => task.id === alert.taskId)?.title ?? "Check-in"} · Due ${formatTimestamp(alert.dueAt)}`));
      item.append(node("p", alert.status === "receipt_pending" ? "Provider accepted; receipt needs review. Operator reconciliation is required; no automatic resend. This status does not prove phone delivery."
        : notification ? `Demo notification for ${notification.recipientMemberName ?? "the caregiver"}. No phone message was sent.`
        : alert.status === "blocked" ? "No caregiver was on duty when the follow-up was recorded. No SMS was sent."
        : "No demo notification is recorded yet. No phone message was sent."));
      if (alert.acknowledgedBy) item.append(node("p", `${alert.acknowledgedBy} acknowledged the follow-up at ${formatTime(alert.acknowledgedAt)}. Evelyn’s check-in is unchanged.`));
      else {
        item.append(node("p", "No caregiver acknowledgment recorded."));
        const acknowledge = node("button", "Theo: acknowledge follow-up"); acknowledge.type = "button";
        acknowledge.addEventListener("click", () => void acknowledgeAlert(alert.id)); item.append(acknowledge);
      }
      return item;
    }));
    if (!alerts.length) $("story-alerts").append(node("p", "No follow-up is recorded. That is not proof of safety.", "story-note"));
    $("story-family-sync").textContent = "Family API checked just now. Parent replies and caregiver acknowledgments are separate.";
    controls();
  }
  async function loadViews({ parent = false, gate = true } = {}) {
    const current = ++readRevision; reading = true;
    try {
      const nextStory = gate ? await readStory() : story;
      if (!active() || current !== readRevision) return false;
      const [family, person] = await Promise.all([json("/api/today"), parent ? mcpCall(connection => connection.today()) : Promise.resolve(null)]);
      if (!active() || current !== readRevision) return false;
      if (!Array.isArray(family.tasks) || !Array.isArray(family.escalations) || (person && !Array.isArray(person.tasks))) throw new Error("Invalid local care response");
      story = nextStory; caregiverSnapshot = family;
      if (person) { parentSnapshot = person; renderParent(); }
      renderClock(); renderCaregiver(); return true;
    } catch {
      if (ready && current === readRevision) $("story-family-sync").textContent = "Could not refresh. Any visible family information is the last known update.";
      return false;
    } finally { if (current === readRevision) reading = false; }
  }
  function clearProposal() { proposal = null; $("story-review").hidden = true; controls(); }
  function draftChanged({ clearContext = false } = {}) {
    $("story-model-consent").checked = false;
    if (clearContext) contextToken = undefined;
    clearProposal();
  }
  function updateBudget(value) {
    if (story && Number.isInteger(value) && value >= 0 && value <= story.conversation.modelLimit) story.conversation.modelRequests = value;
    controls();
  }
  function act(message, action, retry = false) {
    if (!ready || busy || !active() || voice.active || (pending() && !retry)) return Promise.resolve();
    const owner = lifecycle;
    busy = true; readRevision += 1; reading = false; controls(); setStatus(message);
    operation = (async () => {
      try {
        const nextStory = await readStory();
        if (!owns(owner)) return;
        story = nextStory; await action(() => owns(owner));
      } catch { if (owns(owner) && ready) setStatus("The local request did not finish. Your draft is still here. Try again."); }
      finally { if (owns(owner)) { busy = false; controls(); } }
    })();
    return operation;
  }
  async function interpret(event) {
    event.preventDefault();
    if (!ready || busy || !active() || voice.active || pending()) return;
    const message = $("story-message").value.trim();
    if (!message || message.length > 800) { setStatus("Type a request of 1–800 characters. Nothing was sent."); return; }
    const allowModel = $("story-model-consent").checked && story.conversation.mode === "bedrock";
    if (allowModel && story.conversation.modelRequests >= story.conversation.modelLimit) {
      $("story-model-consent").checked = false; controls(); setStatus("This server session reached its model limit. Use an exact command without Nova; nothing was sent."); return;
    }
    const body = { message, ...(contextToken ? { contextToken } : {}), ...(allowModel ? { allowModel: true } : {}) };
    $("story-model-consent").checked = false;
    await act("Reviewing Evelyn’s request…", async current => {
      clearProposal(); addTranscript("Evelyn", message);
      let result;
      try {
        result = await json("/demo/story/conversation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!current()) return;
        updateBudget(result.modelRequests);
        if (!["limited", "bedrock"].includes(result.mode) || (result.mode === "bedrock" && !allowModel)) throw new Error("Unexpected interpretation mode");
      } catch (error) {
        if (!current()) return;
        updateBudget(error.modelRequests);
        const explanation = error.code === "story_model_unavailable" ? "Nova is not enabled on this story server."
          : error.code === "story_model_limit" ? "This server session reached its model limit."
          : error.code === "story_conversation_busy" ? "Another request is already being reviewed."
          : error.status === 400 || error.status === 413 ? "The request could not be accepted. Use 1–800 characters."
          : `The review could not finish.${allowModel ? " A model attempt may still count toward the session limit." : ""}`;
        setStatus(`${explanation} Your draft is still here. Nothing was saved. Choose a reply below, or choose a new model review when available.`); return;
      }
      // Only a newly validated task proposal can carry implicit follow-up context.
      contextToken = undefined;
      if (result.action === "confirm" && result.task && result.expected && ["done", "not_yet", "skipped"].includes(result.response)) {
        proposal = structuredClone(result);
        contextToken = typeof result.contextToken === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(result.contextToken) ? result.contextToken : undefined;
        $("story-proposal").textContent = `Record “${result.task.title}” (due ${formatTime(result.task.dueAt)}) as ${result.response.replaceAll("_", " ")} for Evelyn?`;
        $("story-review").hidden = false;
        addTranscript("Kin", `You want to record ${result.response.replaceAll("_", " ")} for “${result.task.title}”. Review the details below, then confirm. Nothing has been saved.`);
        setStatus(`${result.mode === "bedrock" ? "Nova suggested this reply." : "Kin matched your reply to this check-in."} Ready for your review. No care state has changed.`);
      } else if (result.action === "today") {
        parentSnapshot = await mcpCall(connection => connection.today()); renderParent();
        addTranscript("Kin", parentSnapshot.tasks.length ? parentSnapshot.tasks.map(task => `${task.title}: ${responseLabel(task)}. Due ${formatTime(task.dueAt)}.`).join(" ") : "No check-ins are scheduled today.");
        setStatus("Read through the local MCP server. No check-in was changed.");
      } else if (result.action === "brief") await readBrief();
      else { addTranscript("Kin", "I couldn’t match that to one clear check-in. Choose a reply below, or name the check-in and say what happened. Nothing changed."); setStatus("Your draft is unchanged. Review a specific check-in before confirming."); }
    });
    if (active() && proposal && ready && !busy && !pending()) $("story-confirm").focus();
  }
  async function saveConfirmation(retry = false) {
    await act(retry ? "Checking the same save…" : "Checking the reviewed task…", async currentPage => {
      let attemptedSave = retry;
      try {
        if (!retry) {
          if (!proposal) return;
          const latest = await mcpCall(connection => connection.today()), reviewed = proposal;
          if (!currentPage() || !ready) return;
          const current = latest.tasks.find(task => task.id === reviewed.task.id);
          const keys = ["title", "dueAt", "state", "lastResponse", "confirmedAt", "confirmedBy"];
          if (!current || current.state !== "scheduled" || keys.some(key => (current[key] ?? null) !== (reviewed.expected[key] ?? null))) {
            parentSnapshot = latest; renderParent(); clearProposal();
            addTranscript("Kin", "That check-in changed while you were reviewing it. Ask again to review the current plan. Nothing was saved.");
            setStatus("The review is out of date. Please review Evelyn’s reply again."); return;
          }
          attemptedSave = true;
          await sender.confirm({ taskId: reviewed.task.id, response: reviewed.response, actor: "Evelyn", expected: reviewed.expected });
        } else await sender.retry();
        if (!currentPage()) return;
        draftChanged({ clearContext: true }); $("story-message").value = "";
        addTranscript("Kin", "Your reply is saved to the shared care plan. It is a reported response, not a safety check.");
        const refreshed = await loadViews({ parent: true });
        if (!currentPage()) return;
        setStatus(refreshed ? "Reply saved. Theo’s separate family view has refreshed." : "Reply saved, but the latest family view could not be refreshed. Use Refresh family view.");
      } catch (error) {
        if (!currentPage()) return;
        if (!attemptedSave) { setStatus("Could not read the latest check-in. Your review and draft are still here. No save was attempted. Try confirming again."); return; }
        if (!sender.pending) { clearProposal(); setStatus("That check-in changed or was rejected. Review the current plan before trying again."); }
        else setStatus("The save was not acknowledged. Retry the same check-in below; do not send a different reply yet.");
      }
    }, retry);
  }
  async function sendRest() {
    const intent = pendingRest, owner = lifecycle;
    try {
      await json(intent.url, { method: "POST", headers: { "content-type": "application/json" }, body: intent.body });
      pendingRest = null;
      const refreshed = await loadViews({ parent: true });
      if (!owns(owner)) return;
      setStatus(`${intent.kind === "advance" ? "Demo clock advanced. Notifications stay in this local demo; no phone message was sent." : "Theo acknowledged the follow-up. Evelyn’s check-in was not completed by this action."}${refreshed ? "" : " The latest view could not be refreshed; use Refresh family view."}`);
    } catch (error) {
      if (!owns(owner)) return;
      if ([400, 401, 403, 404, 409, 422].includes(error.status)) { pendingRest = null; setStatus("The local change was rejected. Refresh to check the current story before trying again."); }
      else setStatus("This change was not acknowledged. Retry the same request below before making another change.");
    }
  }
  async function advance() {
    await act("Advancing the synthetic clock…", async current => {
      if (story.step === "after_grace") { await loadViews({ parent: true }); if (current()) setStatus("The demo clock is already at 9:31 AM."); return; }
      pendingRest = { kind: "advance", url: "/demo/story/advance", body: JSON.stringify({ step: "after_grace", confirm: true }) };
      draftChanged({ clearContext: true }); await sendRest();
    });
  }
  async function acknowledgeAlert(id) {
    await act("Recording Theo’s acknowledgment…", async () => {
      pendingRest = { kind: "ack", url: `/api/escalations/${encodeURIComponent(id)}/acknowledge`, body: JSON.stringify({ confirm: true }) };
      draftChanged({ clearContext: true }); await sendRest();
    });
  }
  async function readBrief() {
    const owner = lifecycle;
    const target = $("story-brief-result");
    target.replaceChildren(node("p", "Reading the recorded week through MCP…", "story-note"));
    try {
      const brief = await mcpCall(connection => connection.brief());
      if (brief.generatedBy !== "deterministic" || !Array.isArray(brief.evidence)) throw new Error("Not a local deterministic brief");
      const points = node("ul");
      for (const point of [...brief.highlights, ...brief.followUps]) points.append(node("li", point.text));
      const sources = node("details"), facts = node("ol", null, "story-source-list");
      sources.append(node("summary", `${brief.evidence.length} recorded source facts`));
      for (const fact of brief.evidence) facts.append(node("li", `${formatTimestamp(fact.occurredAt)} · ${fact.fact}`));
      sources.append(facts);
      target.replaceChildren(node("h3", brief.headline), node("p", brief.overview), points, sources, node("p", brief.safetyNotice, "story-note"));
      setStatus("Weekly brief read through MCP. Deterministic synthesis only; no model was invoked.");
    } catch { if (owns(owner)) target.replaceChildren(node("p", "The weekly brief could not be read. Try Read the weekly brief again; no care state changed.", "story-note")); }
  }
  async function refreshFamily() {
    await act("Refreshing Theo’s family view…", async current => {
      const refreshed = await loadViews();
      if (current()) setStatus(refreshed ? "Theo’s family view is up to date with the local server." : "Could not refresh the family view. Any visible information is the last known update.");
    });
  }
  async function poll() {
    if (!active()) return;
    const owner = lifecycle;
    if (ready && !busy && !reading && !pending() && !voice.active && doc.visibilityState === "visible") await loadViews();
    if (owns(owner)) timer = setTimeout(poll, 5000);
  }
  function start() {
    if (busy || !active()) return Promise.resolve();
    const owner = lifecycle;
    busy = true; controls();
    operation = (async () => {
      try {
        const nextStory = await readStory(); if (!owns(owner)) return;
        story = nextStory; mcp ??= makeMcp(event => { if (owns(owner)) onTrace(event); }); ready = true;
        $("story-unavailable").hidden = true; $("story-app").hidden = false;
        renderClock();
        const refreshed = await loadViews({ parent: true, gate: false });
        if (!owns(owner)) return;
        setStatus(pending() ? "The earlier change still needs a receipt. Retry only that same request; nothing was resent while returning."
          : refreshed ? "The story is ready. Begin with an example, or type Evelyn’s request." : "The local story is available, but its care view could not load. Try Refresh family view.");
        clearTimeout(timer); timer = setTimeout(poll, 5000);
      } catch { /* readStory closes the current page instead of falling back to another service. */ }
      finally { if (owns(owner)) { busy = false; controls(); } }
    })();
    return operation;
  }
  $("story-form").addEventListener("submit", event => void interpret(event));
  $("story-suggestions").querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    if (!ready || busy || pending() || voice.active || !active()) return;
    draftChanged({ clearContext: true }); $("story-message").value = button.dataset.prompt; $("story-message").focus(); setStatus("Example added to your draft. Nothing has been sent.");
  }));
  $("story-message").addEventListener("input", () => draftChanged());
  $("story-model-consent").addEventListener("change", controls);
  $("story-voice-status").textContent = voice.supported ? "Optional dictation fills your draft. It never submits or saves a reply." : "Voice input is unavailable in this browser. You can type every request.";
  $("story-voice-start").addEventListener("click", () => {
    if (!ready || busy || pending() || !active() || voice.active || doc.visibilityState === "hidden") return;
    draftChanged(); readRevision += 1; reading = false; voice.start();
  });
  $("story-voice-stop").addEventListener("click", () => voice.stop());
  $("story-voice-cancel").addEventListener("click", () => { voice.cancel(); $("story-voice-status").textContent = "Dictation discarded. Your earlier draft is unchanged."; $("story-message").focus(); });
  $("story-confirm").addEventListener("click", () => void saveConfirmation());
  $("story-cancel").addEventListener("click", () => { if (busy || pending() || voice.active || !active()) return; draftChanged({ clearContext: true }); setStatus("Left unchanged. Your draft is still here."); $("story-message").focus(); });
  $("story-advance").addEventListener("click", () => void advance());
  $("story-refresh").addEventListener("click", () => void refreshFamily());
  $("story-brief").addEventListener("click", () => void act("Reading the weekly brief…", readBrief));
  $("story-retry").addEventListener("click", () => { if (sender.pending) void saveConfirmation(true); else if (pendingRest) void act("Checking the same local change…", sendRest, true); });
  $("story-reconnect").addEventListener("click", () => void start());
  function onVisibility() { if (doc.visibilityState === "hidden") voice.cancel(); }
  doc.addEventListener("visibilitychange", onVisibility);
  function suspend() {
    suspended = true; lifecycle += 1; ready = busy = reading = false; readRevision += 1;
    mcp = undefined;
    clearTimeout(timer); voice.cancel(); draftChanged({ clearContext: true });
    // Pending writes remain in this page's memory. Restoring never resends them.
    controls();
  }
  async function resume() {
    if (disposed || !suspended) return;
    const owner = lifecycle;
    // Let the old, bounded attempt settle while inactive, so its result cannot
    // become a new-page receipt or dispatch work queued before suspension.
    await operation;
    if (disposed || !suspended || owner !== lifecycle) return;
    suspended = false; await start();
  }
  function stop() { suspend(); disposed = true; doc.removeEventListener("visibilitychange", onVisibility); controls(); }
  return { start, suspend, resume, stop };
}

if (typeof document !== "undefined" && document.getElementById("story-root")) {
  const page = createStoryPage(); void page.start();
  window.addEventListener("pagehide", event => { if (event.persisted) page.suspend(); else page.stop(); });
  window.addEventListener("pageshow", event => { if (event.persisted) void page.resume(); });
}
