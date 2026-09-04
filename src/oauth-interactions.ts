import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, urlencoded, type NextFunction, type Request, type Response } from "express";
import type Provider from "oidc-provider";
import { alexaScopes } from "./auth.js";
import {
  InvalidCredentialsError,
  UnsupportedSignInChallengeError,
  type AuthenticatedAccount,
} from "./cognito-authenticator.js";

interface AccountAuthenticator {
  authenticate(username: string, password: string): Promise<AuthenticatedAccount>;
}

export interface OAuthInteractionRouterInput {
  provider: Provider;
  authenticator: AccountAuthenticator;
  resourceUri: string;
  csrfSecret: string;
}

const maxFormBytes = "8kb";
const allowedUserScopes = new Set<string>([alexaScopes.tools, alexaScopes.resources]);

export function createOAuthInteractionRouter(input: OAuthInteractionRouterInput): Router {
  if (input.csrfSecret.length < 32) throw new Error("OAuth CSRF secret must be at least 32 characters");
  const router = Router();

  router.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    next();
  });
  router.use(urlencoded({ extended: false, limit: maxFormBytes }));

  router.get("/interaction/:uid", asyncHandler(async (request, response) => {
    const details = await verifiedDetails(input.provider, request, response);
    renderPrompt(response, details, csrfToken(input.csrfSecret, details.uid));
  }));

  router.post("/interaction/:uid/login", asyncHandler(async (request, response) => {
    const details = await verifiedDetails(input.provider, request, response);
    verifyPost(request, input.csrfSecret, details.uid, "login", details.prompt.name);
    const username = scalarBody(request.body?.username);
    const password = scalarBody(request.body?.password);
    try {
      const account = await input.authenticator.authenticate(username, password);
      await input.provider.interactionFinished(
        request,
        response,
        { login: { accountId: account.accountId } },
        { mergeWithLastSubmission: false },
      );
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        renderPrompt(
          response,
          details,
          csrfToken(input.csrfSecret, details.uid),
          "We couldn't sign you in. Check your email and password, then try again.",
          401,
          username,
        );
        return;
      }
      if (error instanceof UnsupportedSignInChallengeError) {
        renderPrompt(
          response,
          details,
          csrfToken(input.csrfSecret, details.uid),
          "This account needs an additional security step. Finish account setup, then try again.",
          409,
          username,
        );
        return;
      }
      throw error;
    }
  }));

  router.post("/interaction/:uid/consent", asyncHandler(async (request, response) => {
    const details = await verifiedDetails(input.provider, request, response);
    verifyPost(request, input.csrfSecret, details.uid, "consent", details.prompt.name);
    const accountId = details.session?.accountId;
    const clientId = details.params.client_id;
    if (!accountId || !clientId) throw new InteractionRequestError("Authorization session is incomplete");

    let grant = details.grantId ? await input.provider.Grant.find(details.grantId) : undefined;
    grant ??= new input.provider.Grant({ accountId, clientId });
    const resources = details.prompt.details.missingResourceScopes ?? {};
    for (const [resource, scopes] of Object.entries(resources)) {
      if (resource !== input.resourceUri || scopes.some((scope) => !allowedUserScopes.has(scope))) {
        throw new InteractionRequestError("Authorization request contains an unsupported permission");
      }
      grant.addResourceScope(resource, scopes.join(" "));
    }
    const grantId = await grant.save();
    await input.provider.interactionFinished(
      request,
      response,
      { consent: { grantId } },
      { mergeWithLastSubmission: true },
    );
  }));

  router.post("/interaction/:uid/cancel", asyncHandler(async (request, response) => {
    const details = await verifiedDetails(input.provider, request, response);
    verifyCsrf(request, input.csrfSecret, details.uid);
    await input.provider.interactionFinished(
      request,
      response,
      { error: "access_denied", error_description: "The family member declined access" },
      { mergeWithLastSubmission: false },
    );
  }));

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (!(error instanceof InteractionRequestError)) {
      next(error);
      return;
    }
    response.status(400).type("text").send("This authorization request is no longer valid. Start again from Alexa+.");
  });

  return router;
}

class InteractionRequestError extends Error {}

async function verifiedDetails(provider: Provider, request: Request, response: Response) {
  const details = await provider.interactionDetails(request, response);
  if (details.uid !== request.params.uid) throw new InteractionRequestError("Interaction does not match");
  if (details.prompt.name !== "login" && details.prompt.name !== "consent") {
    throw new InteractionRequestError("Unsupported authorization step");
  }
  return details;
}

function verifyPost(
  request: Request,
  secret: string,
  uid: string,
  expectedPrompt: string,
  actualPrompt: string,
) {
  verifyCsrf(request, secret, uid);
  if (actualPrompt !== expectedPrompt) throw new InteractionRequestError("Authorization step changed");
}

function verifyCsrf(request: Request, secret: string, uid: string) {
  const submitted = scalarBody(request.body?.csrf);
  const expected = csrfToken(secret, uid);
  const submittedBytes = Buffer.from(submitted);
  const expectedBytes = Buffer.from(expected);
  if (submittedBytes.length !== expectedBytes.length || !timingSafeEqual(submittedBytes, expectedBytes)) {
    throw new InteractionRequestError("Invalid form token");
  }
}

function csrfToken(secret: string, uid: string) {
  return createHmac("sha256", secret).update(`kin-oauth:${uid}`).digest("base64url");
}

function scalarBody(value: unknown) {
  return typeof value === "string" ? value : "";
}

function renderPrompt(
  response: Response,
  details: Awaited<ReturnType<Provider["interactionDetails"]>>,
  csrf: string,
  error?: string,
  status = 200,
  username = "",
) {
  const nonce = randomBytes(18).toString("base64url");
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  response.status(status).type("html").send(page({
    uid: details.uid,
    prompt: details.prompt.name as "login" | "consent",
    nonce,
    csrf,
    error,
    username,
  }));
}

function page(input: {
  uid: string;
  prompt: "login" | "consent";
  nonce: string;
  csrf: string;
  error?: string;
  username: string;
}) {
  const uid = escapeHtml(encodeURIComponent(input.uid));
  const csrf = escapeHtml(input.csrf);
  const signIn = input.prompt === "login";
  const title = signIn ? "Bring your care circle together" : "Connect Kin to Alexa+";
  const eyebrow = signIn ? "Family sign in" : "One clear permission";
  const body = signIn
    ? "Use the private family account your Kin organizer invited."
    : "Alexa+ will be able to read care tasks and confirm them when your family member asks.";
  const primary = signIn ? "Continue securely" : "Allow and connect";
  const action = signIn ? "login" : "consent";
  const fields = signIn ? `
    <label>Email<input name="username" type="email" inputmode="email" autocomplete="username" value="${escapeHtml(input.username)}" maxlength="320" required autofocus></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" minlength="8" maxlength="1024" required></label>` : `
    <div class="permission"><span aria-hidden="true">✓</span><div><strong>Care tasks</strong><p>Read today's shared plan and record voice confirmations.</p></div></div>
    <p class="promise">Kin never gives Alexa+ your password. You can disconnect access later.</p>`;
  const error = input.error ? `<div class="error" role="alert">${escapeHtml(input.error)}</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Kin</title>
<style nonce="${input.nonce}">
:root{color-scheme:light;--ink:#17332c;--muted:#587068;--paper:#fbfaf5;--leaf:#246b53;--line:#dfe6de;--sun:#f3c66f}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% 4%,#fff4d7 0,transparent 32rem),var(--paper);color:var(--ink);font-family:ui-rounded,"Avenir Next",Avenir,system-ui,sans-serif;display:grid;place-items:center;padding:24px}.shell{width:min(100%,460px)}.brand{display:flex;align-items:center;gap:10px;font-weight:750;letter-spacing:-.02em;margin:0 0 28px}.mark{width:31px;height:31px;border:2px solid var(--leaf);border-radius:50% 50% 45% 55%;display:grid;place-items:center;color:var(--leaf)}main{background:#fff;border:1px solid var(--line);border-radius:28px;padding:clamp(28px,7vw,42px);box-shadow:0 24px 70px rgba(30,65,54,.10)}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:.72rem;font-weight:800;color:var(--leaf)}h1{font-family:Georgia,serif;font-weight:500;font-size:clamp(2rem,8vw,2.65rem);line-height:1.03;letter-spacing:-.035em;margin:12px 0 14px}p{color:var(--muted);line-height:1.55;margin:0 0 24px}label{display:grid;gap:8px;font-size:.86rem;font-weight:750;margin:18px 0}input{width:100%;border:1px solid #b9c8c0;border-radius:12px;padding:14px 15px;font:inherit;color:var(--ink);background:#fff;outline:none}input:focus{border-color:var(--leaf);box-shadow:0 0 0 4px rgba(36,107,83,.13)}button{width:100%;border:0;border-radius:999px;padding:15px 18px;font:inherit;font-weight:800;cursor:pointer}.primary{background:var(--leaf);color:#fff;margin-top:8px}.primary:hover{background:#185541}.cancel{background:transparent;color:var(--muted);margin-top:7px}.error{background:#fff1ed;color:#8d3528;border-radius:12px;padding:12px 14px;line-height:1.4;margin:18px 0}.permission{display:flex;gap:14px;border:1px solid var(--line);border-radius:16px;padding:17px;margin:26px 0}.permission>span{flex:0 0 28px;height:28px;background:#e2f2e9;color:var(--leaf);border-radius:50%;display:grid;place-items:center;font-weight:900}.permission strong{display:block;margin:2px 0 4px}.permission p{font-size:.9rem;margin:0}.promise{font-size:.82rem;border-left:3px solid var(--sun);padding-left:12px}.fine{font-size:.75rem;text-align:center;margin:22px 0 0;color:#71837d}@media(max-width:420px){body{padding:0}.shell{width:100%}.brand{padding:20px 22px 0}main{border-width:1px 0 0;border-radius:28px 28px 0 0;min-height:calc(100vh - 78px)}}
</style></head><body><div class="shell"><div class="brand"><span class="mark" aria-hidden="true">K</span>Kin</div><main><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${body}</p>${error}<form method="post" action="/interaction/${uid}/${action}"><input type="hidden" name="csrf" value="${csrf}">${fields}<button class="primary" type="submit">${primary}</button></form><form method="post" action="/interaction/${uid}/cancel"><input type="hidden" name="csrf" value="${csrf}"><button class="cancel" type="submit">Not now</button></form><p class="fine">Private by design · Built for families, not surveillance</p></main></div></body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function asyncHandler(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: (error?: unknown) => void) => {
    handler(request, response).catch(next);
  };
}
