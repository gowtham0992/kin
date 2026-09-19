const pendingKey = "kin.browser-login";
const closedKey = "kin.workspace-closed";
const fail = () => Object.assign(new Error("Sign-in could not be completed. Start again."), { status: 401 });
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const workspaceViews = new Set(["ask", "today", "plan", "circle", "week", "invite", "access"]);
// Store only a view name, never a destination URL or an arbitrary fragment.
const entryView = value => typeof value === "string" && workspaceViews.has(value) ? value : "today";

export function createBrowserAuth({ config, origin, storage, request = fetch, cryptoApi = crypto, now = Date.now }) {
  const base = new URL(origin);
  if (base.protocol !== "https:" || config.issuer !== base.origin || config.redirectUri !== `${base.origin}/invite.html` ||
      config.resource !== `${base.origin}/mcp` || !/^[A-Za-z0-9_-]{16,100}$/.test(config.clientId)) throw fail();
  let token = null;
  let expiresAt = 0;
  let generation = 0;
  let returnView = null;
  const cookieMode = config.sessionMode === "cookie";
  let sessionBinding = null;
  let sessionWrite = Promise.resolve();
  let renewalAttempted = false;
  async function cookieRequest(method, bearer) {
    return request("/browser-session", { method, credentials: "same-origin", redirect: "error", cache: "no-store",
      headers: { "x-kin-workspace": "1", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, signal: AbortSignal.timeout(10000) });
  }
  async function restore(revision) {
    const response = await cookieRequest("GET");
    if (revision !== generation) throw fail();
    if ([401, 403].includes(response.status)) return false;
    if (!response.ok) throw fail();
    const result = await response.json();
    if (!Number.isFinite(result.expiresAt) || result.expiresAt <= now() || result.expiresAt > now() + 3600000 ||
        !/^[a-f0-9]{64}$/.test(result.binding ?? "")) throw fail();
    if (revision !== generation) throw fail();
    expiresAt = result.expiresAt;
    token = "cookie-session"; // Local connection marker, never a credential.
    sessionBinding = result.binding;
    return true;
  }
  return {
    get connected() { return !!token && now() < expiresAt; },
    get returnView() { return returnView; },
    get canRenew() { return cookieMode && !renewalAttempted && storage.getItem(closedKey) !== "1"; },
    async start(view = "today", { silent = false } = {}) {
      if (silent && (!cookieMode || renewalAttempted || storage.getItem(closedKey) === "1")) throw fail();
      if (silent) renewalAttempted = true;
      else storage.removeItem(closedKey);
      token = null;
      expiresAt = 0;
      returnView = null;
      generation += 1;
      const revision = generation;
      if (cookieMode && !silent) {
        await sessionWrite.catch(() => {});
        const closed = await cookieRequest("DELETE");
        if (!closed.ok || revision !== generation) throw fail();
      }
      storage.removeItem(pendingKey);
      const state = encode(cryptoApi.getRandomValues(new Uint8Array(32)));
      const verifier = encode(cryptoApi.getRandomValues(new Uint8Array(32)));
      const challenge = encode(new Uint8Array(await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      if (revision !== generation) throw fail();
      storage.setItem(pendingKey, JSON.stringify({ state, verifier, createdAt: now(), clientId: config.clientId, returnView: entryView(view), ...(silent ? { silent: true } : {}) }));
      const url = new URL("/auth", origin);
      url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
        response_type: "code", scope: "mcp:tools mcp:resources", resource: config.resource,
        // Returning accounts still need connection review to enter a newly issued invitation.
        state, code_challenge: challenge, code_challenge_method: "S256", prompt: silent ? "none" : "login consent" }).toString();
      return url.href;
    },
    async complete(urlInput) {
      const url = new URL(urlInput);
      if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
        if (cookieMode) await restore(generation);
        return false;
      }
      returnView = null;
      const saved = storage.getItem(pendingKey);
      storage.removeItem(pendingKey);
      const pending = saved ? JSON.parse(saved) : null;
      const params = url.searchParams;
      if (`${url.origin}${url.pathname}` !== config.redirectUri || !pending ||
          params.getAll("state").length !== 1 || params.get("state") !== pending.state ||
          params.getAll("iss").length !== 1 || params.get("iss") !== config.issuer ||
          pending.clientId !== config.clientId || !Number.isFinite(pending.createdAt) ||
          now() - pending.createdAt < 0 || now() - pending.createdAt > 600000 ||
          !/^[A-Za-z0-9_-]{43}$/.test(pending.verifier)) throw fail();
      if (pending.silent === true) renewalAttempted = true;
      if (params.has("error")) {
        if (pending.silent === true && params.getAll("error").length === 1 && !params.has("code") &&
            ["login_required", "consent_required", "interaction_required", "account_selection_required"].includes(params.get("error"))) return false;
        throw fail();
      }
      if (params.getAll("code").length !== 1 || !params.get("code") || params.get("code").length > 2048) throw fail();
      const revision = generation;
      const response = await request("/token", { method: "POST", redirect: "error", cache: "no-store", credentials: "omit",
        headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId,
          redirect_uri: config.redirectUri, code: params.get("code"), code_verifier: pending.verifier, resource: config.resource }).toString(),
      });
      if (!response.ok) throw fail();
      const result = await response.json();
      if (revision !== generation || result.token_type !== "Bearer" || typeof result.access_token !== "string" ||
          !result.access_token || result.access_token.length > 16384 || !Number.isFinite(result.expires_in) ||
          result.expires_in <= 0 || result.expires_in > 3600 ||
          !String(result.scope ?? "").split(" ").includes("mcp:tools")) throw fail();
      if (cookieMode) {
        sessionWrite = cookieRequest("POST", result.access_token);
        const established = await sessionWrite;
        if (!established.ok || revision !== generation) throw fail();
        if (!await restore(revision)) throw fail();
      } else {
        token = result.access_token;
        expiresAt = now() + result.expires_in * 1000;
      }
      returnView = entryView(pending.returnView);
      return true;
    },
    disconnect() {
      generation += 1; token = null; expiresAt = 0; returnView = null; storage.removeItem(pendingKey);
      if (cookieMode) storage.setItem(closedKey, "1");
      if (cookieMode) return (async () => {
        await sessionWrite.catch(() => {});
        const response = await cookieRequest("DELETE");
        if (!response.ok) throw fail();
      })();
    },
    suspend() { generation += 1; token = null; expiresAt = 0; returnView = null; },
    async request(path, options = {}) {
      const target = new URL(path, origin);
      const mcp = target.href === config.resource && ["POST", "DELETE"].includes(String(options.method ?? "GET").toUpperCase());
      if (target.origin !== base.origin || (!target.pathname.startsWith("/api/") && !mcp) || target.username || target.password ||
          !token || now() >= expiresAt) throw fail();
      const headers = new Headers(options.headers);
      if (cookieMode) { headers.delete("authorization"); headers.set("x-kin-workspace", "1"); headers.set("x-kin-session", sessionBinding); }
      else headers.set("authorization", `Bearer ${token}`);
      const revision = generation;
      const response = await request(target.href, { ...options, headers, redirect: "error", credentials: cookieMode ? "same-origin" : "omit", cache: "no-store" });
      if (revision !== generation) throw fail();
      if (response.status === 401) { token = null; expiresAt = 0; returnView = null; }
      return response;
    },
  };
}
