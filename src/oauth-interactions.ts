import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, urlencoded, type NextFunction, type Request, type Response } from "express";
import type Provider from "oidc-provider";
import { alexaScopes } from "./auth.js";
import { familyConsentVersion, invitationFingerprint, InvitationUnavailableError, type FamilyEnrollment, type Invitation } from "./invitations.js";
import {
  InvalidCredentialsError,
  NewPasswordRequiredError,
  NewPasswordRejectedError,
  UnsupportedSignInChallengeError,
  type AuthenticatedAccount,
} from "./cognito-authenticator.js";

export interface AccountAuthenticator {
  authenticate(username: string, password: string, newPassword?: string): Promise<AuthenticatedAccount>;
}

export interface OAuthInteractionRouterInput {
  provider: Provider;
  authenticator: AccountAuthenticator;
  resourceUri: string;
  csrfSecret: string;
  enrollment?: FamilyEnrollment;
  browserClientId?: string;
  echoClientId?: string;
  desktopClientId?: string;
}

const maxFormBytes = "8kb";
const allowedUserScopes = new Set<string>([alexaScopes.tools, alexaScopes.resources]);

export function createOAuthInteractionRouter(input: OAuthInteractionRouterInput): Router {
  if (input.csrfSecret.length < 32) throw new Error("OAuth CSRF secret must be at least 32 characters");
  const router = Router();

  router.use((request, response, next) => {
    response.locals.browserClientId = input.browserClientId;
    response.locals.echoClientId = input.echoClientId;
    response.locals.desktopClientId = input.desktopClientId;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    next();
  });
  const parseForm = urlencoded({ extended: false, limit: maxFormBytes });

  router.get("/interaction/:uid", asyncHandler(async (request, response) => {
    const details = await verifiedDetails(input.provider, request, response);
    renderPrompt(response, details, csrfToken(input.csrfSecret, details.uid), undefined, 200, "", input.enrollment ? {} : undefined);
  }));

  router.post("/interaction/:uid/invitation", parseForm, asyncHandler(async (request, response) => {
    const details = await verifiedDetails(input.provider, request, response);
    verifyPost(request, input.csrfSecret, details.uid, "consent", details.prompt.name);
    const accountId = details.session?.accountId;
    if (!input.enrollment || !accountId) throw new InteractionRequestError("Enrollment unavailable");
    const code = scalarBody(request.body?.invitation).trim();
    try {
      const invitation = await input.enrollment.review(accountId, code);
      renderPrompt(response, details, csrfToken(input.csrfSecret, details.uid), undefined, 200, "", {
        code, invitation, proof: invitationProof(input.csrfSecret, details.uid, accountId, code, invitation),
      });
    } catch (error) {
      if (!(error instanceof InvitationUnavailableError)) throw error;
      renderPrompt(response, details, csrfToken(input.csrfSecret, details.uid), error.message, 400, "", {});
    }
  }));

  router.post("/interaction/:uid/login", parseForm, asyncHandler(async (request, response) => {
    const details = await verifiedDetails(input.provider, request, response);
    verifyPost(request, input.csrfSecret, details.uid, "login", details.prompt.name);
    const username = scalarBody(request.body?.username);
    const password = scalarBody(request.body?.password);
    try {
      const newPassword = scalarBody(request.body?.newPassword);
      if (request.body?.newPassword !== undefined && (!newPassword || newPassword !== scalarBody(request.body?.confirmPassword))) throw new NewPasswordRejectedError();
      const authenticationStartedAt = Date.now();
      const account = newPassword ? await input.authenticator.authenticate(username, password, newPassword) : await input.authenticator.authenticate(username, password);
      const authenticatedAt = account.authenticatedAt ?? authenticationStartedAt;
      if (!Number.isFinite(authenticatedAt) || authenticatedAt <= 0 || authenticatedAt > Date.now()) {
        throw new Error("Invalid server authentication time");
      }
      await input.provider.interactionFinished(
        request,
        response,
        { login: { accountId: account.accountId, ts: authenticatedAt / 1_000 } },
        { mergeWithLastSubmission: false },
      );
    } catch (error) {
      if (error instanceof NewPasswordRequiredError || error instanceof NewPasswordRejectedError) {
        response.locals.passwordSetup = true;
        renderPrompt(response, details, csrfToken(input.csrfSecret, details.uid),
          error instanceof NewPasswordRejectedError ? "Passwords must match and meet the requirements below. Re-enter your temporary password and try again." : undefined,
          error instanceof NewPasswordRejectedError ? 400 : 200, username);
        return;
      }
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

  router.post("/interaction/:uid/consent", parseForm, asyncHandler(async (request, response) => {
    const details = await verifiedDetails(input.provider, request, response);
    verifyPost(request, input.csrfSecret, details.uid, "consent", details.prompt.name);
    const accountId = details.session?.accountId;
    const clientId = details.params.client_id;
    if (!accountId || !clientId) throw new InteractionRequestError("Authorization session is incomplete");
    // The primary button and Enter can submit the unreviewed invitation form.
    // Treat that as review only: never save a grant or membership implicitly.
    const unreviewedCode = scalarBody(request.body?.invitation).trim();
    if (input.enrollment && unreviewedCode && request.body?.invitationProof === undefined && request.body?.familyConsent === undefined) {
      try {
        const invitation = await input.enrollment.review(accountId, unreviewedCode);
        renderPrompt(response, details, csrfToken(input.csrfSecret, details.uid), undefined, 200, "", {
          code: unreviewedCode, invitation, proof: invitationProof(input.csrfSecret, details.uid, accountId, unreviewedCode, invitation),
        });
      } catch (error) {
        if (!(error instanceof InvitationUnavailableError)) throw error;
        renderPrompt(response, details, csrfToken(input.csrfSecret, details.uid), error.message, 400, "", {});
      }
      return;
    }
    const clientScopes = clientId === input.echoClientId ? new Set<string>([alexaScopes.tools]) : allowedUserScopes;

    let grant = details.grantId ? await input.provider.Grant.find(details.grantId) : undefined;
    grant ??= new input.provider.Grant({ accountId, clientId });
    const oidcScopes = details.prompt.details.missingOIDCScope ?? [];
    const oidcClaims = details.prompt.details.missingOIDCClaims ?? [];
    if (oidcScopes.some((scope) => !clientScopes.has(scope)) || oidcClaims.length > 0) {
      throw new InteractionRequestError("Authorization request contains an unsupported permission");
    }
    if (oidcScopes.length > 0) grant.addOIDCScope(oidcScopes.join(" "));
    const resources = details.prompt.details.missingResourceScopes ?? {};
    for (const [resource, scopes] of Object.entries(resources)) {
      if (resource !== input.resourceUri || scopes.some((scope) => !clientScopes.has(scope))) {
        throw new InteractionRequestError("Authorization request contains an unsupported permission");
      }
      grant.addResourceScope(resource, scopes.join(" "));
    }
    const invitationCode = scalarBody(request.body?.invitation).trim();
    if (invitationCode) {
      if (!input.enrollment || scalarBody(request.body?.familyConsent) !== familyConsentVersion) {
        throw new InteractionRequestError("Explicit family consent is required");
      }
      try {
        const invitation = await input.enrollment.review(accountId, invitationCode);
        const expected = invitationProof(input.csrfSecret, details.uid, accountId, invitationCode, invitation);
        const submitted = scalarBody(request.body?.invitationProof);
        if (!/^[a-f0-9]{64}$/.test(submitted) || !timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))) {
          throw new InteractionRequestError("Invitation terms changed");
        }
        await input.enrollment.accept(accountId, invitationCode, familyConsentVersion, invitation);
      } catch (error) {
        if (!(error instanceof InvitationUnavailableError)) throw error;
        renderPrompt(response, details, csrfToken(input.csrfSecret, details.uid), error.message, 400, "", {});
        return;
      }
    }
    const grantId = await grant.save();
    await input.provider.interactionFinished(
      request,
      response,
      { consent: { grantId } },
      { mergeWithLastSubmission: true },
    );
  }));

  router.post("/interaction/:uid/cancel", parseForm, asyncHandler(async (request, response) => {
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
    response.status(400).type("text").send("This authorization request is no longer valid. Return to the app where you started and sign in again.");
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

function invitationProof(secret: string, uid: string, accountId: string, code: string, invitation: Invitation) {
  return createHmac("sha256", secret).update(JSON.stringify([uid, accountId, code, invitationFingerprint(invitation), familyConsentVersion])).digest("hex");
}

interface EnrollmentPrompt { code?: string; invitation?: Invitation; proof?: string }

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
  enrollment?: EnrollmentPrompt,
) {
  const nonce = randomBytes(18).toString("base64url");
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  response.status(status).type("html").send(page({
    browser: !!response.locals.browserClientId && details.params.client_id === response.locals.browserClientId,
    echo: !!response.locals.echoClientId && details.params.client_id === response.locals.echoClientId,
    desktop: !!response.locals.desktopClientId && details.params.client_id === response.locals.desktopClientId,
    uid: details.uid,
    prompt: details.prompt.name as "login" | "consent",
    nonce,
    csrf,
    error,
    username,
    enrollment,
    passwordSetup: response.locals.passwordSetup === true,
  }));
}

function page(input: {
  passwordSetup: boolean;
  browser: boolean;
  echo: boolean;
  desktop: boolean;
  uid: string;
  prompt: "login" | "consent";
  nonce: string;
  csrf: string;
  error?: string;
  username: string;
  enrollment?: EnrollmentPrompt;
}) {
  const uid = escapeHtml(encodeURIComponent(input.uid));
  const csrf = escapeHtml(input.csrf);
  const signIn = input.prompt === "login";
  const reviewed = !signIn ? input.enrollment?.invitation : undefined;
  const title = signIn ? input.passwordSetup ? "Make this account yours" : "Bring your care circle together" : reviewed ? "A place in the circle" : input.browser ? "Open your family workspace" : input.echo ? "Connect Kin to your Echo" : input.desktop ? "Connect Kin to the desktop acceptance client" : "Connect Kin to Alexa+";
  const eyebrow = signIn ? "Family sign in" : reviewed ? "Your choice to join" : "Account connection";
  const body = signIn
    ? input.passwordSetup ? "Use the temporary password from your email once more. Then set your own." : "Use the private family account your Kin organizer invited."
    : reviewed ? input.browser
      ? "Check who you are joining and what you can do. Accepting opens this browser workspace within your family permissions."
      : input.echo ? "Check who you are joining and what you can do. Accepting also connects the Kin custom skill to this account, within your family role's permissions."
        : input.desktop ? "Check who you are joining and what you can do. Accepting also connects the desktop acceptance client to this account, within your family role's permissions."
        : "Check who you are joining and what you can do. Accepting also connects Kin to Alexa+, within your role's permissions."
      : input.browser ? "This browser can use Kin within your existing family permissions. Signing in alone does not grant membership or organizer access."
        : input.echo ? "The Kin custom skill can read your shared family plan and record reviewed check-in confirmations within your role's permissions. Connecting does not grant family membership."
        : input.desktop ? "The desktop acceptance client can read your shared family plan and use MCP tools within your family role's permissions. Connecting alone does not grant family membership."
        : "Alexa+ can use Kin within your family role's permissions. Connecting alone does not grant family membership.";
  const primary = signIn ? input.passwordSetup ? "Set password and continue" : "Continue securely" : reviewed ? input.browser ? "Join circle and open workspace" : input.desktop ? "Join circle and connect desktop client" : "Join circle and connect" : input.browser ? "Open workspace" : "Allow and connect";
  const action = signIn ? "login" : "consent";
  const fields = signIn ? `
    <label>Email<input name="username" type="email" inputmode="email" autocomplete="username" value="${escapeHtml(input.username)}" maxlength="320" required autofocus></label>
    <label>${input.passwordSetup ? "Temporary password from email" : "Password"}<input name="password" type="password" autocomplete="current-password" minlength="8" maxlength="1024" required></label>
    ${input.passwordSetup ? `<p class="promise">Use 12–256 characters with uppercase and lowercase letters, a number, and a symbol. No spaces. Choose something different from the temporary password.</p><label>New password<input name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><label>Confirm new password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label>` : ""}` : `
    ${reviewed ? "" : `<div class="permission"><span aria-hidden="true">✓</span><div><strong>${input.browser ? "Your family permissions" : "Care tasks"}</strong><p>${input.browser ? "Read care activity and use the actions your family role permits. Only designated organizers can invite." : input.desktop ? "Read care information and widgets. Record reviewed check-in confirmations only if your role permits it." : "Read the shared plan. Record voice confirmations only if your role permits it."}</p></div></div>`}
    <p class="promise">${input.browser ? "Closing this workspace does not remove your family membership or sign you out of the account provider." : input.echo ? "Kin never gives Alexa your password. Disconnecting the skill does not remove your family membership." : input.desktop ? "Kin never gives the desktop client your password. Closing it does not remove your family membership or sign you out of the account provider." : "Kin never gives Alexa+ your password. Disconnecting Alexa does not remove your family membership."}</p>
    ${input.echo ? '<p class="promise">Anyone who can speak to this Echo may use the linked Kin skill with this account\'s permissions. This connection does not verify the speaker\'s identity. Link only an account whose family information and allowed actions you are comfortable sharing on this device.</p>' : ""}
    ${reviewed ? `<section class="invitation"><div class="eyebrow">Your invitation</div><h2>${escapeHtml(reviewed.circleName)}</h2><p>You are joining as <strong>${escapeHtml(reviewed.name)}</strong>.</p><p>${escapeHtml(roleDescription(reviewed.role))}</p><input type="hidden" name="invitation" value="${escapeHtml(input.enrollment?.code ?? "")}"><input type="hidden" name="invitationProof" value="${escapeHtml(input.enrollment?.proof ?? "")}"><label class="consent"><input type="checkbox" name="familyConsent" value="${familyConsentVersion}" required><span>I agree to join this shared care circle with these permissions. My recorded care activity will be visible to other circle members.</span></label></section>`
      : input.enrollment ? `<section class="invitation"><label>Have a family invitation?<input name="invitation" autocomplete="off" spellcheck="false" maxlength="43" placeholder="Paste your invitation code"></label><button class="cancel" type="submit" formaction="/interaction/${uid}/invitation" formnovalidate>Review invitation</button><p class="promise">New here? Review your invitation before connecting. Already a member? Leave the code empty.</p></section>` : ""}`;
  const error = input.error ? `<div class="error" role="alert">${escapeHtml(input.error)}</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Kin</title>
<style nonce="${input.nonce}">.invitation{border-top:1px solid var(--line);padding-top:20px;margin-top:24px}.invitation h2{font-family:Georgia,serif;font-weight:500;font-size:1.5rem;overflow-wrap:anywhere}.invitation .consent{display:flex;align-items:flex-start;gap:12px;font-weight:500;line-height:1.5}.consent input{width:20px;height:20px;flex:0 0 20px;margin-top:3px;accent-color:var(--leaf)}button:focus-visible{outline:3px solid var(--leaf);outline-offset:4px}</style>
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

function roleDescription(role: Invitation["role"]) {
  return {
    viewer: "Viewer: you can read the shared care plan, family roster, and weekly brief. You cannot confirm tasks or change duty coverage.",
    care_recipient: "Care recipient: you can read the shared care plan, family roster, and weekly brief, and confirm care tasks. You cannot change duty coverage.",
    caregiver: "Caregiver: you can read the shared care plan, family roster, and weekly brief, confirm care tasks, and change duty coverage.",
  }[role];
}

function asyncHandler(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: (error?: unknown) => void) => {
    handler(request, response).catch(next);
  };
}
