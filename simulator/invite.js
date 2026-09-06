import { createInvitationClient, invitationError } from "./invite-client.js";

const client = createInvitationClient();
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

async function load() {
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
    status.textContent = invitationError(error.status);
    $("invite-reload").hidden = false;
  }
}

$("invite-reload").addEventListener("click", () => void load());
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
    status.textContent = invitationError(error.status, true);
    $("invite-confirm").checked = false;
    if ([401, 403, 404].includes(error.status)) { form.hidden = true; $("invite-reload").hidden = false; }
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
window.addEventListener("pagehide", clearReceipt);
window.addEventListener("pageshow", event => { if (event.persisted) void load(); });
void load();
