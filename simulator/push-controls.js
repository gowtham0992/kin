export function createPushControls({ request, container }) {
  let generation = 0;
  const reset = () => { generation++; if (container) { container.replaceChildren(); container.hidden = true; } };
  return { reset, async open(config) {
    reset(); if (!container || !config) return;
    container.hidden = false;
    const current = generation, owns = () => current === generation;
    const make = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
    const heading = make("summary", "On-duty notifications"), details = make("details", "");
    details.className = "kin-push-controls";
    const status = make("div", "Checking this phone’s connection…");
    status.className = "kin-push-status";
    status.setAttribute("role", "status");
    const enable = make("button", "Enable on this phone"), disable = make("button", "Turn off on this phone");
    const check = make("button", "Check connection");
    for (const button of [enable, disable, check]) { button.type = "button"; button.className = "secondary"; }
    const introduction = make("p", "Connecting a phone does not activate automatic follow-ups. Check Today directly while delivery is unverified.");
    introduction.className = "kin-push-intro";
    const actions = make("div", ""); actions.className = "kin-push-actions";
    actions.append(enable, disable, check);
    const consent = make("p", "Choosing Enable replaces your previously selected phone. Lock-screen notices contain no care details. Push is best-effort, not an emergency service.");
    consent.className = "kin-push-boundary";
    details.append(heading, introduction, status, consent, actions);
    container.append(details);
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      enable.hidden = disable.hidden = check.hidden = true;
      status.textContent = "Push is unavailable here. On iPhone, add Kin to your home screen and open it there first.";
      return;
    }
    let enrollment = null, pendingEnrollment = null;
    const lock = value => { enable.disabled = disable.disabled = check.disabled = value; };
    const fingerprint = async subscription => {
      const value = subscription.toJSON();
      const bytes = new TextEncoder().encode(JSON.stringify([value.endpoint, value.keys.p256dh, value.keys.auth]));
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    };
    const registration = async () => {
      let timer;
      try { return await Promise.race([navigator.serviceWorker.ready,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("App not ready")), 8000); })]); }
      finally { clearTimeout(timer); }
    };
    async function refresh(prefix = "") {
      const [response, worker] = await Promise.all([
        request("/api/push/subscription", { method: "GET", signal: AbortSignal.timeout(8000) }), registration(),
      ]);
      if (!owns()) return;
      if (!response.ok) throw new Error("Status unavailable");
      const data = await response.json(), local = await worker.pushManager.getSubscription();
      if (!owns()) return;
      if (!["none", "saved", "disabled", "expired"].includes(data.enrollment?.state)
        || (data.enrollment.state === "saved" ? !/^[a-f0-9]{64}$/.test(data.enrollment.id) : data.enrollment.id !== null)
        || typeof data.duty?.assigned !== "boolean" || typeof data.duty?.onDuty !== "boolean") throw new Error("Invalid status");
      const localId = local ? await fingerprint(local) : null;
      if (!owns()) return;
      enrollment = data.enrollment;
      const connected = localId !== null && enrollment.state === "saved" && enrollment.id === localId;
      if (connected) pendingEnrollment = null;
      const connection = connected ? "This phone is connected to this account."
        : enrollment.state === "saved" ? "A saved connection does not match this browser."
        : enrollment.state === "expired" ? "Your saved phone connection has expired."
        : enrollment.state === "disabled" ? "Notifications are off for this account."
        : "No phone is connected to this account.";
      const permission = Notification.permission === "granted" ? "Phone permission is granted."
        : Notification.permission === "denied" ? "Notifications are blocked in your phone’s browser settings."
        : "Phone permission has not been granted.";
      const duty = !data.duty.assigned ? "No one is on duty right now."
        : data.duty.onDuty ? "You are on duty right now." : "You are not on duty right now.";
      const facts = make("dl", ""); facts.className = "kin-push-facts";
      for (const [label, value] of [["This phone", `${connection} ${permission}`], ["Your turn", duty], ["Delivery", "Automatic delivery has not been verified."]]) {
        const row = make("div", ""); row.append(make("dt", label), make("dd", value)); facts.append(row);
      }
      status.replaceChildren();
      if (prefix) status.append(make("p", prefix));
      status.append(facts);
      if (local && !connected && !pendingEnrollment) status.append(make("p", "Turn off this phone’s existing connection before enabling it for this account."));
      enable.textContent = pendingEnrollment ? "Retry connection" : connected ? "Reconnect this phone" : "Enable on this phone";
    }
    async function checkConnection() {
      if (check.disabled) return;
      lock(true);
      try { await refresh(); }
      catch { if (owns()) { enrollment = null; status.textContent = "Kin could not verify this phone’s connection. Check your connection and try again; no settings were changed."; } }
      finally { if (owns()) lock(false); }
    }
    check.addEventListener("click", checkConnection);
    enable.addEventListener("click", async () => {
      if (enable.disabled) return;
      lock(true);
      try {
        // Permission is requested only from the caregiver's explicit gesture.
        const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
        if (!owns()) return;
        if (permission !== "granted") { status.textContent = "Notifications were not enabled. You can change permission in your browser settings."; return; }
        const worker = await registration(); if (!owns()) return;
        let subscription = await worker.pushManager.getSubscription(); if (!owns()) return;
        if (subscription) {
          const id = await fingerprint(subscription); if (!owns()) return;
          const knownPending = pendingEnrollment && id === await fingerprint(pendingEnrollment);
          if (!owns()) return;
          if (!knownPending && !(enrollment?.state === "saved" && enrollment.id === id)) {
            status.textContent = "This phone’s existing connection is not verified for this account. Turn off on this phone first, then enable it. Nothing was changed.";
            return;
          }
        } else {
          const key = Uint8Array.from(atob(config.publicKey.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
          subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
          if (!owns()) return;
        }
        // Keep the same subscription after an uncertain response. The server may
        // already have saved it; unsubscribing here would destroy that connection.
        pendingEnrollment = subscription;
        const response = await request("/api/push/subscription", { method: "POST", signal: AbortSignal.timeout(8000), headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscription: subscription.toJSON(), consent: true, consentVersion: config.consentVersion }) });
        if (!owns()) return;
        if (!response.ok) throw new Error("Could not save destination");
        pendingEnrollment = null;
        enrollment = { state: "saved", id: await fingerprint(subscription) };
        if (!owns()) return;
        await refresh("Connection saved. No test notification was sent.");
      } catch {
        if (owns()) {
          status.textContent = "Kin could not verify that the connection was saved. Nothing was unsubscribed. Choose Retry connection to safely try again.";
          enable.textContent = "Retry connection";
        }
      } finally { if (owns()) lock(false); }
    });
    disable.addEventListener("click", async () => {
      if (disable.disabled) return;
      lock(true);
      try {
        const worker = await registration(); if (!owns()) return;
        const subscription = await worker.pushManager.getSubscription(); if (!owns()) return;
        if (subscription) {
          const response = await request("/api/push/subscription", { method: "DELETE", signal: AbortSignal.timeout(8000), headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
          if (!owns()) return;
          if (!response.ok) throw new Error("Could not remove destination");
          if (!await subscription.unsubscribe()) throw new Error("Could not unsubscribe");
        }
        if (owns()) {
          pendingEnrollment = null; enrollment = null;
          enable.textContent = "Enable on this phone";
          status.textContent = "Notifications are off on this phone. Other selected phones are unchanged. An already queued notification may still arrive.";
        }
      } catch { if (owns()) status.textContent = "Kin could not verify that notifications are off. Try Turn off again, or block them in your browser settings."; }
      finally { if (owns()) lock(false); }
    });
    await checkConnection();
  } };
}
