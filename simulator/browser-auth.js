const pendingKey = "kin.browser-login";
const fail = () => Object.assign(new Error("Sign-in could not be completed. Start again."), { status: 401 });
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function createBrowserAuth({ config, origin, storage, request = fetch, cryptoApi = crypto, now = Date.now }) {
  const base = new URL(origin);
  if (base.protocol !== "https:" || config.issuer !== base.origin || config.redirectUri !== `${base.origin}/invite.html` ||
      config.resource !== `${base.origin}/mcp` || !/^[A-Za-z0-9_-]{16,100}$/.test(config.clientId)) throw fail();
  let token = null;
  let expiresAt = 0;
  let generation = 0;
  return {
    get connected() { return !!token && now() < expiresAt; },
    async start() {
      token = null;
      generation += 1;
      const state = encode(cryptoApi.getRandomValues(new Uint8Array(32)));
      const verifier = encode(cryptoApi.getRandomValues(new Uint8Array(32)));
      const challenge = encode(new Uint8Array(await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      storage.setItem(pendingKey, JSON.stringify({ state, verifier, createdAt: now(), clientId: config.clientId }));
      const url = new URL("/auth", origin);
      url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
        response_type: "code", scope: "mcp:tools mcp:resources", resource: config.resource,
        state, code_challenge: challenge, code_challenge_method: "S256", prompt: "login" }).toString();
      return url.href;
    },
    async complete(urlInput) {
      const url = new URL(urlInput);
      if (!url.searchParams.has("code") && !url.searchParams.has("error")) return false;
      const saved = storage.getItem(pendingKey);
      storage.removeItem(pendingKey);
      const pending = saved ? JSON.parse(saved) : null;
      const params = url.searchParams;
      if (`${url.origin}${url.pathname}` !== config.redirectUri || !pending ||
          params.getAll("state").length !== 1 || params.get("state") !== pending.state ||
          params.getAll("iss").length !== 1 || params.get("iss") !== config.issuer ||
          params.getAll("code").length !== 1 || params.has("error") ||
          pending.clientId !== config.clientId || !Number.isFinite(pending.createdAt) ||
          now() - pending.createdAt < 0 || now() - pending.createdAt > 600000 ||
          !/^[A-Za-z0-9_-]{43}$/.test(pending.verifier) || !params.get("code") || params.get("code").length > 2048) throw fail();
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
      token = result.access_token;
      expiresAt = now() + result.expires_in * 1000;
      return true;
    },
    disconnect() { generation += 1; token = null; expiresAt = 0; storage.removeItem(pendingKey); },
    suspend() { generation += 1; token = null; expiresAt = 0; },
    async request(path, options = {}) {
      const target = new URL(path, origin);
      if (target.origin !== base.origin || !target.pathname.startsWith("/api/") || target.username || target.password ||
          !token || now() >= expiresAt) throw fail();
      const headers = new Headers(options.headers);
      headers.set("authorization", `Bearer ${token}`);
      const revision = generation;
      const response = await request(target.href, { ...options, headers, redirect: "error", credentials: "omit" });
      if (revision !== generation) throw fail();
      if (response.status === 401) { token = null; expiresAt = 0; }
      return response;
    },
  };
}
