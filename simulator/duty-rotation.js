const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const date = value => new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

// A proposal is read-only, scoped to this rendered view, and never stored between sessions.
export function renderDutyRotation({ propose, onSave, isLocked, onError }) {
  let alive = true, loading = false;
  const element = node("section", null, "care-rotation"), review = node("div"), message = node("p", "", "care-note");
  message.setAttribute("role", "status"); review.hidden = true;
  const start = node("button", "Propose next week", "secondary"); start.type = "button";
  element.append(node("h3", "Make room for next week."),
    node("p", "Kin fills uncovered days, giving the next turn to the caregiver with fewer assigned days. Your existing plans stay in place."), start, message, review);
  start.addEventListener("click", async () => {
    if (!alive || loading || isLocked()) return;
    loading = true; start.disabled = true; review.hidden = true;
    message.textContent = "Looking at your coverage…";
    try {
      const proposal = await propose();
      if (!alive || isLocked()) return;
      const heading = node("h4", `${date(proposal.startDate)} – ${date(proposal.endDate)}`);
      heading.setAttribute("tabindex", "-1");
      const note = node("p", `Based on assigned days from ${date(proposal.basisStartDate)} to ${date(proposal.basisEndDate)} · ${proposal.timeZone}`, "care-note");
      const table = node("table", null, "care-rotation-balance"), caption = node("caption", "Share of scheduled responsibility");
      const head = node("thead"), header = node("tr");
      for (const label of ["Caregiver", "14-day basis", "Next week"]) { const cell = node("th", label); cell.setAttribute("scope", "col"); header.append(cell); }
      head.append(header); const body = node("tbody");
      for (const person of proposal.members) {
        const row = node("tr"), name = node("th", person.name); name.setAttribute("scope", "row");
        row.append(name, node("td", String(person.basisAssignedDays)), node("td", String(person.existingNextWeekDays + person.proposedDays))); body.append(row);
      }
      table.append(caption, head, body);
      const days = node("ul", null, "care-rotation-days");
      for (const day of proposal.days) {
        const row = node("li"), detail = node("span");
        detail.append(node("strong", day.assignment?.memberName ?? "Uncovered"),
          node("span", day.source === "existing" ? "Already agreed" : day.source === "proposed" ? "Suggested" : "Needs a caregiver", "care-note"));
        row.append(node("span", date(day.date)), detail); days.append(row);
      }
      const save = node("button", `Confirm ${proposal.proposedDays} ${proposal.proposedDays === 1 ? "new day" : "new days"}`, "primary"); save.type = "button";
      save.disabled = proposal.proposedDays === 0 || proposal.uncoveredDays > 0;
      save.addEventListener("click", () => {
        if (!alive || isLocked() || save.disabled) return;
        void onSave({ startDate: proposal.startDate, reviewToken: proposal.reviewToken });
      });
      const cancel = node("button", "Keep unchanged", "secondary"); cancel.type = "button";
      cancel.addEventListener("click", () => { if (!alive || isLocked()) return; review.hidden = true; review.replaceChildren(); start.focus(); });
      const actions = node("div", null, "care-actions"); actions.append(save, cancel);
      review.replaceChildren(heading, note, table, days, node("p", "Assigned days describe coverage, not how much care someone provides.", "care-note"), actions);
      review.hidden = false; heading.focus();
      message.textContent = proposal.uncoveredDays > 0 ? "No eligible caregiver can cover these days. Ask the organizer to finish alert setup."
        : proposal.proposedDays === 0 ? "Next week is already covered. Nothing needs to change." : "Review each suggested day before confirming.";
    } catch (error) {
      if (!alive) return;
      message.textContent = "Could not prepare the rotation. Try again when your connection is ready.";
      onError(error);
    } finally { loading = false; if (alive) start.disabled = isLocked(); }
  });
  return { element, get loading() { return loading; }, destroy() { alive = false; review.replaceChildren(); } };
}
