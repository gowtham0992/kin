const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
};

// Ephemeral form state only. Never persist names or carry a draft across sessions.
export function createRosterDraft() {
  let value = null;
  return {
    read: () => value ? { ...value } : null,
    start(input) { value = { ...input, review: false }; },
    update(input) { if (value) value = { ...value, ...input, review: false }; },
    review() { if (value) value = { ...value, name: value.name.trim(), review: true }; },
    clear() { value = null; },
  };
}

export function renderRosterEditor({ data, draft, isLocked, onSave, onMessage }) {
  const section = node("section", null, "circle-people");
  const heading = node("h3", "The people in your circle"); heading.id = "roster-people-heading"; heading.tabIndex = -1;
  const list = node("ul", null, "circle-people-list"), renameButtons = new Map();
  const button = (label, action, primary = false) => {
    const result = node("button", label, primary ? "primary" : "secondary"); result.type = "button";
    result.addEventListener("click", () => { if (!isLocked()) return action(); });
    return result;
  };
  const add = button("Add someone", () => {
    draft.start({ action: "add", name: "", relationship: "caregiver" }); showDraft(); name.focus();
  });
  add.disabled = data.members.length >= data.limit;
  const introduction = node("div", null, "circle-people-heading");
  introduction.append(heading, add);
  section.append(introduction,
    node("p", "These are names in the shared care plan, not logins or alert subscriptions. Adding someone does not invite them or turn on messages.", "care-note"));
  for (const person of data.members) {
    const item = node("li"), copy = node("div");
    copy.append(node("h4", person.name), node("p", `${person.relationship === "parent" ? "Person receiving care" : "Caregiver"} · ${person.canReceiveAlerts ? "Eligible for duty" : "Duty and alerts not set up"}`, "care-note"));
    item.append(copy);
    if (person.canEnableDuty) item.append(button("Set up for turns", () => {
      draft.start({ action: "enable_duty", memberId: person.id, expectedName: person.name, name: person.name });
      draft.review(); showDraft(); document.getElementById("roster-editor-review")?.focus();
    }));
    if (person.canConnectSelf) item.append(button("Connect to my account", () => {
      draft.start({ action: "connect_self", memberId: person.id, expectedName: person.name, name: person.name });
      draft.review(); showDraft(); document.getElementById("roster-editor-review")?.focus();
    }));
    if (person.canRename) {
      const rename = button("Edit name", () => {
        draft.start({ action: "rename", memberId: person.id, expectedName: person.name, name: person.name }); showDraft(); name.focus();
      });
      rename.setAttribute("aria-label", `Edit name for ${person.name}`);
      renameButtons.set(person.id, rename); item.append(rename);
    } else copy.append(node("p", "Linked to an account or invitation. This name cannot be changed here.", "care-note circle-person-lock"));
    list.append(item);
  }
  if (!data.members.length) list.append(node("li", "Start with the person receiving care and someone who helps. Account access is a separate step."));
  section.append(list);
  if (add.disabled) section.append(node("p", `This circle has reached its limit of ${data.limit} people. No one has been removed.`, "care-note"));
  const form = node("form", null, "invite-panel circle-person-form"); form.id = "roster-editor-form";
  const formHeading = node("h4"), nameLabel = node("label", "Name for this circle"), name = node("input");
  name.id = "roster-person-name"; nameLabel.htmlFor = name.id; name.required = true; name.maxLength = 80; name.autocomplete = "off";
  const roleLabel = node("label", "Role in the care plan"), role = node("select");
  role.id = "roster-person-role"; roleLabel.htmlFor = role.id;
  role.add(new Option("Caregiver", "caregiver")); role.add(new Option("Person receiving care", "parent"));
  const note = node("p", "Invite the caregiver to join, then use Set up for turns to make them eligible for duty. Choosing a shift and connecting their phone are separate steps.", "care-note");
  const error = node("p", "", "circle-person-error"); error.setAttribute("role", "alert"); error.id = "roster-person-error";
  name.setAttribute("aria-describedby", error.id);
  const actions = node("div", null, "care-actions"), submit = node("button", "Review addition", "primary"); submit.type = "submit";
  const dismiss = () => {
    const previous = draft.read(); draft.clear(); showDraft();
    (previous?.action === "rename" ? renameButtons.get(previous.memberId) ?? add : add).focus();
  };
  actions.append(submit, button("Cancel", dismiss));
  const review = node("section", null, "care-alerts circle-person-review"); review.id = "roster-editor-review";
  form.append(formHeading, nameLabel, name, roleLabel, role, note, error,
    node("p", "Your draft stays while switching Kin tabs or using Refresh. Reloading this page or closing the session clears it.", "care-note"), actions, review);
  section.append(form, node("p", "A name change only updates the circle’s current display name. Saved history and account names stay as they were; this never reassigns someone’s identity.", "care-note"));
  function showReview(value, focus = false) {
    review.hidden = !value?.review;
    submit.className = value?.review ? "secondary" : "primary";
    if (!value?.review) return;
    review.tabIndex = -1;
    if (value.action === "enable_duty") {
      review.replaceChildren(node("h4", `Make ${value.name} available for turns?`),
        node("p", "This caregiver has joined the circle. They will become eligible for duty assignments. No shift is assigned, no phone notifications are enabled, and nothing is sent.", "care-note"));
      const controls = node("div", null, "care-actions");
      const confirm = button("Confirm eligibility", async () => {
        const current = draft.read();
        if (current?.action !== "enable_duty" || !current.review) return;
        const { review: _review, ...input } = current;
        await onSave({ ...input, confirm: true });
        if (!draft.read()) document.getElementById("roster-people-heading")?.focus();
      }, true);
      controls.append(confirm, button("Cancel", dismiss)); review.append(controls);
      if (focus) confirm.focus();
      return;
    }
    review.replaceChildren(node("h4", value.action === "connect_self" ? "Connect this entry to you?" : value.action === "add" ? "Add this person?" : "Review this name change"),
      node("p", value.action === "connect_self" ? value.name : value.action === "add" ? `${value.name} · ${value.relationship === "parent" ? "Person receiving care" : "Caregiver"}` : `${value.expectedName} → ${value.name}`, "circle-person-change"),
      node("p", value.action === "connect_self" ? "Replaces this unused name-only entry with your existing caregiver account. Your login and selected phone stay unchanged. You become eligible for duty, but no shift is assigned and no notification is sent." : value.action === "add" ? "Adds a name only. No account, invitation, duty shift, or alert subscription will be created." : "Updates this person’s current roster name only. Saved history, account names, duty assignments, and queued messages are unchanged.", "care-note"));
    const reviewActions = node("div", null, "care-actions");
    const confirm = button(value.action === "connect_self" ? "Confirm account connection" : value.action === "add" ? "Confirm addition" : "Confirm name change", async () => {
      const current = draft.read();
      if (!current?.review) return;
      const { review: _review, ...input } = current;
      await onSave({ ...input, confirm: true });
      if (!draft.read()) document.getElementById("roster-people-heading")?.focus();
    }, true);
    reviewActions.append(confirm, button(value.action === "connect_self" ? "Cancel" : "Back to editing", () => {
      if (value.action === "connect_self") { dismiss(); return; }
      draft.update({}); showReview(null); name.focus();
    }));
    review.append(reviewActions);
    if (focus) confirm.focus();
  }
  function showDraft() {
    const value = draft.read(); form.hidden = !value;
    error.textContent = "";
    name.value = value?.name ?? ""; role.value = value?.relationship ?? "caregiver";
    role.hidden = roleLabel.hidden = value?.action !== "add";
    note.hidden = value?.action !== "add";
    name.hidden = nameLabel.hidden = actions.hidden = value?.action === "connect_self" || value?.action === "enable_duty";
    formHeading.textContent = value?.action === "enable_duty" ? "Duty eligibility" : value?.action === "connect_self" ? "Your caregiver account" : value?.action === "rename" ? "Edit this person’s name" : "Make room for someone";
    submit.textContent = value?.action === "rename" ? "Review name change" : "Review addition";
    showReview(value);
  }
  name.addEventListener("input", () => { draft.update({ name: name.value }); showReview(null); error.textContent = ""; });
  role.addEventListener("change", () => { draft.update({ relationship: role.value }); showReview(null); });
  form.addEventListener("submit", event => {
    event.preventDefault(); if (isLocked() || !form.reportValidity()) return;
    const value = draft.read(); if (!value) return;
    if (/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name.value)) {
      error.textContent = "Use a name without control or directional characters."; name.focus(); return;
    }
    const trimmed = name.value.trim();
    if (!trimmed || trimmed.length > 80) { error.textContent = "Use a name between 1 and 80 characters."; name.focus(); return; }
    if (value.action === "rename" && trimmed === value.expectedName) { error.textContent = "The name is unchanged. Edit it or cancel."; name.focus(); return; }
    if (value.action === "rename" && !data.members.some(person => person.id === value.memberId && person.canRename && person.name === value.expectedName)) {
      error.textContent = "This person’s name or access changed. Cancel this draft and review the current circle."; onMessage(error.textContent); return;
    }
    if (value.action === "add" && data.members.length >= data.limit) { error.textContent = "This circle is full. No one has been added."; return; }
    draft.update({ name: trimmed, ...(value.action === "add" ? { relationship: role.value } : {}) });
    draft.review(); showReview(draft.read(), true);
  });
  showDraft();
  return { element: section, clear() { draft.clear(); showDraft(); } };
}
