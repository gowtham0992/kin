// Installation is optional and must never block sign-in or request push permission.
export function setupInstall({ window, navigator, button, status }) {
  let pending, installationObserved = false;
  const installed = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  button.hidden = true;
  const showInstalled = () => {
    pending = undefined; button.hidden = true;
    status.textContent = installed()
      ? "Kin is open as an app. A connection is needed to load your family plan."
      : "Kin is installed. To use it as an app, open the Kin icon from your home screen or apps.";
  };
  if (installed()) showInstalled();
  else status.textContent = "Kin is open in a browser tab. You can keep using it here, or add it to your home screen.";
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    if (installed()) return;
    pending = event; button.hidden = false;
  });
  window.addEventListener("appinstalled", () => { installationObserved = true; showInstalled(); });
  button.addEventListener("click", async () => {
    const prompt = pending;
    if (!prompt || button.disabled) return;
    pending = undefined; button.disabled = true;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (installationObserved || installed()) showInstalled();
      else status.textContent = choice.outcome === "accepted"
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
