import { createInvitationClient, invitationError } from "./invite-client.js";
import { createBrowserAuth } from "./browser-auth.js";
import { createWorkspace } from "./workspace.js";

let auth = null;
let entryGeneration = 0, suspended = false;
const ownsEntry = generation => !suspended && generation === entryGeneration;
const client = createInvitationClient({ request: (...args) => auth ? auth.request(...args) : fetch(...args) });
const $ = id => document.getElementById(id);
const form = $("invite-form");
const status = $("invite-status");
const fields = $("invite-fields");
const result = $("invite-result");
const roleNotes = {
  viewer: "See the care plan, family roster, and weekly brief. Cannot confirm tasks or change duty assignments.",
  care_recipient: "See family care activity and confirm care tasks. Cannot change duty assignments or invite anyone.",
  caregiver: "See family care activity, confirm tasks, and change duty assignments. Cannot invite anyone.",
};
let busy = false;
let receipt = null;
const workspace = createWorkspace({
  request: (...args) => auth ? auth.request(...args) : fetch(...args),
  onInvite: load,
  onLeaveInvite: clearReceipt,
  onAccessLost(code, pending) {
    clearReceipt(); $("invitation-area").hidden = true;
    status.textContent = pending?.outcomeUnknown === true && /^[A-Za-z0-9_-]{1,100}$/.test(pending.requestId ?? "")
      ? `Your family access changed. The pending change may have completed. Ask an organizer to check the care plan before trying again. Reference: ${pending.requestId}.`
      : code === 403 ? "Your account does not have active family access. Ask your organizer to review your membership." : code === 401 ? "Your workspace session ended. Sign in to reconnect." : "Kin could not load the workspace. Check your connection and try again.";
    $("browser-signin").hidden = !auth; $("invite-reload").hidden = false;
  },
});

async function load() {
  $("invitation-area").hidden = false;
  $("browser-disconnect").hidden = !auth?.connected;
  $("browser-signin").hidden = !auth || auth.connected;
  form.hidden = true;
  $("invite-reload").hidden = true;
  status.textContent = "Checking organizer access…";
  try {
    const data = await client.options();
    $("invite-member").replaceChildren(new Option("Choose from your roster", ""));
    for (const member of data.members) $("invite-member").add(new Option(`${member.name} · ${member.relationship}`, member.id));
    status.textContent = data.members.length ? "" : "There is nobody else on the roster yet. Add a family roster member before creating an invitation.";
    form.hidden = !data.members.length;
    $("invite-reload").hidden = !!data.members.length;
  } catch (error) {
    if (error.stale) return;
    status.textContent = error.status === 401 && auth ? "Sign in to open your family workspace." : invitationError(error.status);
    $("browser-signin").hidden = !auth || auth.connected;
    $("invite-reload").hidden = false;
  }
}

$("invite-reload").addEventListener("click", () => void (auth?.connected ? workspace.open() : initialize()));
$("invite-role").addEventListener("change", () => { $("role-note").textContent = roleNotes[$("invite-role").value]; });
form.addEventListener("input", () => { $("invite-confirm").checked = false; });
// The checkbox's own input should remain checked; only identity/permission edits reset consent.
$("invite-confirm").addEventListener("input", event => event.stopPropagation());
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !form.reportValidity()) return;
  busy = true;
  fields.disabled = true;
  $("invite-submit").textContent = "Creating code…";
  status.textContent = "";
  const input = { memberId: $("invite-member").value, email: $("invite-email").value.trim(), role: $("invite-role").value };
  try {
    receipt = await client.issue(input);
    $("invite-summary").textContent = `${$("invite-member").selectedOptions[0].textContent} · ${input.email} · ${$("invite-role").selectedOptions[0].textContent}`;
    $("invite-code").value = receipt.code;
    $("invite-expiry").textContent = `Expires ${new Date(receipt.expiresAt * 1000).toLocaleString()}. Nothing has been emailed.`;
    form.hidden = true;
    result.hidden = false;
    result.focus();
  } catch (error) {
    if (error.stale) return;
    status.textContent = error.status === 401 && auth ? "Your workspace session ended. Sign in again before creating another invitation." : invitationError(error.status, true);
    $("invite-confirm").checked = false;
    if ([401, 403, 404].includes(error.status)) { form.hidden = true; $("invite-reload").hidden = false; }
    if (error.status === 401 && auth) { $("browser-signin").hidden = false; $("browser-disconnect").hidden = true; }
  } finally {
    busy = false;
    fields.disabled = false;
    $("invite-submit").textContent = "Create invitation code";
  }
});
$("invite-copy").addEventListener("click", async () => {
  if (!receipt) return;
  try { await navigator.clipboard.writeText(receipt.code); $("copy-status").textContent = "Copied. Share it only with the intended person."; }
  catch { $("copy-status").textContent = "Copy was blocked. Select the code above and copy it manually."; $("invite-code").focus(); $("invite-code").select(); }
});
function clearReceipt() {
  client.reset();
  receipt = null;
  $("invite-code").value = "";
  $("invite-summary").textContent = "";
  $("invite-expiry").textContent = "";
  $("copy-status").textContent = "";
  result.hidden = true;
  form.reset();
  $("role-note").textContent = roleNotes.viewer;
}
$("invite-clear").addEventListener("click", () => { clearReceipt(); void load().then(() => { if (!form.hidden) $("invite-member").focus(); }); });
window.addEventListener("pagehide", () => {
  suspended = true; entryGeneration += 1;
  workspace.reset(); clearReceipt(); auth?.suspend(); $("browser-signin").disabled = true;
});
window.addEventListener("pageshow", event => { if (event.persisted) { suspended = false; void initialize(); } });
$("browser-signin").addEventListener("click", async () => {
  if (suspended || !auth || $("browser-signin").disabled) return;
  const current = ++entryGeneration, owner = auth;
  $("browser-signin").disabled = true;
  try {
    // Turns uses the existing allowlisted Circle return view through sign-in.
    const view = window.location.hash.slice(1);
    const target = await owner.start(view === "turns" ? "circle" : view);
    if (ownsEntry(current) && auth === owner) window.location.assign(target);
  } catch {
    if (!ownsEntry(current)) return;
    status.textContent = "Kin could not start sign-in. Check that this browser allows session storage and try again."; $("browser-signin").disabled = false;
  }
});
$("browser-disconnect").addEventListener("click", async () => {
  entryGeneration += 1;
  const current = entryGeneration;
  const closing = auth?.disconnect(); workspace.reset(); clearReceipt(); form.hidden = true; $("invitation-area").hidden = true;
  $("browser-signin").disabled = true; $("browser-disconnect").disabled = true;
  status.textContent = "Closing workspace session…";
  try { await closing; }
  catch {
    if (!ownsEntry(current)) return;
    status.textContent = "Kin could not confirm sign-out. Check your connection and try closing the session again.";
    $("browser-disconnect").disabled = false;
    return;
  }
  if (!ownsEntry(current)) return;
  $("browser-disconnect").disabled = false;
  $("browser-disconnect").hidden = true; $("browser-signin").hidden = false; $("browser-signin").disabled = false;
  status.textContent = "Workspace session closed. This does not sign you out of the account provider or remove family access.";
});
async function initialize() {
  if (suspended) return;
  const current = ++entryGeneration;
  auth?.suspend(); auth = null; workspace.reset(); clearReceipt();
  $("browser-signin").disabled = true;
  const callbackUrl = window.location.href;
  if (window.location.search) window.history.replaceState(null, "", "/invite.html");
  try {
    const response = await fetch("/family-auth-config", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!ownsEntry(current)) return;
    if (response.ok) {
      const config = await response.json();
      if (!ownsEntry(current)) return;
      const owner = createBrowserAuth({ config, origin: window.location.origin, storage: window.sessionStorage });
      auth = owner;
      const completed = await owner.complete(callbackUrl);
      if (!ownsEntry(current)) return;
      if (!owner.connected && owner.canRenew) {
        // One top-level same-origin renewal on page entry. Do not redirect an
        // active editor or automatically retry an uncertain care mutation.
        const view = new URL(callbackUrl).hash.slice(1);
        const target = await owner.start(view === "turns" ? "circle" : view, { silent: true });
        if (ownsEntry(current) && auth === owner) window.location.assign(target);
        return;
      }
      if (completed) window.history.replaceState(null, "", `/invite.html#${owner.returnView === "circle" ? "turns" : owner.returnView}`);
      $("browser-disconnect").hidden = !auth.connected;
    } else if (response.status !== 404) throw new Error("Unavailable");
    if (auth) {
      $("browser-signin").hidden = auth.connected;
      $("invitation-area").hidden = true;
      status.textContent = auth.connected ? "" : "Sign in to see your family’s care plan. Care activity is shared only with your circle.";
      if (auth.connected) await workspace.open();
    } else {
      await workspace.open();
      if (!ownsEntry(current)) return;
      if ($("workspace-nav").hidden) await load();
    }
  } catch {
    if (!ownsEntry(current)) return;
    form.hidden = true;
    status.textContent = "Kin could not complete sign-in. Start again to open the workspace.";
    $("browser-signin").hidden = !auth;
    $("invite-reload").hidden = false;
  } finally {
    if (ownsEntry(current)) $("browser-signin").disabled = false;
  }
}
void initialize();
