// Read-only local rendering fixture. No passwords accepted, sessions issued, or AWS calls.
import express from "express";
import type Provider from "oidc-provider";
import { createOAuthInteractionRouter } from "../src/oauth-interactions.js";
const clientId = "kin-family-browser";
const app = express();
const passwordSetup = process.argv[2] === "password-setup";
app.use((_req, res, next) => { res.locals.passwordSetup = passwordSetup; next(); });
app.use((req, res, next) => { if (req.method !== "GET") { res.status(405).send("Read-only preview"); return; } next(); });
app.use(createOAuthInteractionRouter({
  provider: { async interactionDetails() { return { uid: "preview", params: { client_id: clientId },
    prompt: { name: passwordSetup ? "login" : "consent", details: {} }, session: { accountId: "synthetic" } }; } } as unknown as Provider,
  authenticator: { async authenticate() { throw new Error("Read-only preview"); } },
  resourceUri: "https://example.invalid/mcp", csrfSecret: "synthetic-preview-secret-no-real-access", browserClientId: clientId,
}));
const server = app.listen(3018, "127.0.0.1", () => console.log("Read-only browser consent preview: http://127.0.0.1:3018/interaction/preview"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
