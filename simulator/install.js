// Installation is optional and must never block sign-in or request push permission.
export function setupInstall({ window, navigator, button, status }) {
  let pending;
  const installed = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  button.hidden = true;
  const showInstalled = () => {
    pending = undefined; button.hidden = true;
    status.textContent = "Kin is open as an app. A connection is needed to load your family plan.";
  };
  if (installed()) showInstalled();
  else status.textContent = "Kin is open in a browser tab. To use it as an app, add it to your home screen and open the Kin icon. On iPhone, use Share → Add to Home Screen. Installation does not turn on notifications; check Today directly until delivery is verified.";
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    if (installed()) return;
    pending = event; button.hidden = false;
  });
  window.addEventListener("appinstalled", showInstalled);
  button.addEventListener("click", async () => {
    const prompt = pending;
    if (!prompt || button.disabled) return;
    pending = undefined; button.disabled = true;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      status.textContent = choice.outcome === "accepted"
        ? "Installation requested. Look for Kin on your home screen or in your apps."
        : "You can keep using Kin in this browser.";
    } catch {
      status.textContent = "Use your browser’s menu to add Kin to your home screen, or keep using it here.";
    } finally { button.disabled = false; button.hidden = true; }
  });
  if (window.isSecureContext && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/kin-sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      status.textContent = "App setup is unavailable in this browser. You can still use Kin here with a connection.";
    });
  }
}

if (typeof document !== "undefined") {
  const button = document.getElementById("install-kin"), status = document.getElementById("install-status");
  if (button && status) setupInstall({ window, navigator, button, status });
}
