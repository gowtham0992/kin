import express, { type Request, type Response } from "express";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type Provider from "oidc-provider";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { InvalidCredentialsError, NewPasswordRequiredError } from "../src/cognito-authenticator.js";
import { createOAuthInteractionRouter } from "../src/oauth-interactions.js";
import { createDynamoFamilyEnrollment, familyConsentVersion, invitationKey, type FamilyEnrollment, type Invitation } from "../src/invitations.js";
import { membershipKey } from "../src/membership.js";

const uid = "interaction-123";
const resourceUri = "https://example.execute-api.us-east-1.amazonaws.com/mcp";
const csrfSecret = "a-secure-interaction-secret-that-is-long-enough";

function fixture(prompt: "login" | "consent" = "login", enrollment?: FamilyEnrollment, browser = false) {
  const details = {
    uid,
    prompt: {
      name: prompt,
      details: prompt === "consent" ? {
        missingResourceScopes: {
          [resourceUri]: ["mcp:tools", "mcp:resources"],
        } as Record<string, string[]>,
      } : {},
    },
    params: { client_id: browser ? "kin-family-browser" : "alexa-user-client" },
    session: prompt === "consent" ? { accountId: "family-account" } : undefined,
  };
  const addResourceScope = vi.fn();
  const addOIDCScope = vi.fn();
  const save = vi.fn(async () => "grant-123");
  class Grant {
    static find = vi.fn();
    addResourceScope = addResourceScope;
    addOIDCScope = addOIDCScope;
    save = save;
  }
  const interactionFinished = vi.fn(async (
    _request: Request,
    response: Response,
    _result: Record<string, unknown>,
  ) => {
    response.status(303).set("Location", "/resume").end();
  });
  const provider = {
    interactionDetails: vi.fn(async () => details),
    interactionFinished,
    Grant,
  } as unknown as Provider;
  const authenticate = vi.fn(async () => ({
    accountId: "family-account",
    username: "owner@example.com",
  }));
  const app = express();
  app.use(createOAuthInteractionRouter({
    provider,
    authenticator: { authenticate },
    resourceUri,
    csrfSecret,
    enrollment,
    browserClientId: "kin-family-browser",
  }));
  app.use((_error: unknown, _request: Request, response: Response, _next: unknown) => {
    response.status(500).send("Something went wrong");
  });
  return { app, details, authenticate, interactionFinished, addOIDCScope, addResourceScope, save };
}

function csrfFrom(html: string) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  if (!match?.[1]) throw new Error("CSRF token not found");
  return match[1];
}

function storedEnrollment(rosterBound: boolean) {
  const circleId = "family-a", issuer = new URL(resourceUri).origin, code = "b".repeat(43);
  const now = () => new Date("2026-09-07T12:00:00Z");
  const accessKey = membershipKey(circleId, issuer, "family-account");
  const invitation: Invitation = { circleId, circleName: "Synthetic family", memberId: "maya", name: "Maya", role: "viewer",
    targetKey: accessKey.SK, status: "pending", expiresAt: Math.floor(now().getTime() / 1000) + 3600,
    ...(rosterBound ? { rosterBound: true } : {}) };
  const inviteKey = invitationKey(circleId, code);
  const rows = new Map<string, Record<string, unknown>>([
    [inviteKey.SK, { ...inviteKey, ...invitation }],
    ["MEMBER#maya", { PK: accessKey.PK, SK: "MEMBER#maya", entityType: "CircleMember", id: "maya", name: "Maya",
      relationship: "daughter", canReceiveAlerts: false,
      ...(rosterBound ? { accountKey: accessKey.SK, pendingInvitation: inviteKey.SK } : {}) }],
  ]);
  // Keep the real enrollment service and router; only the SDK transport is synthetic.
  const send = vi.fn(async (command: GetCommand | TransactWriteCommand) => {
    if (command instanceof GetCommand) return { Item: structuredClone(rows.get(String(command.input.Key?.SK))) };
    const items = command.input.TransactItems ?? [];
    for (const item of items) {
      if (item.Put && rows.has(String(item.Put.Item?.SK))) throw Object.assign(new Error("Synthetic existing account"), { name: "TransactionCanceledException" });
    }
    for (const item of items) {
      if (item.Put?.Item) rows.set(String(item.Put.Item.SK), structuredClone(item.Put.Item));
      if (item.Update?.Key?.SK === inviteKey.SK) Object.assign(rows.get(inviteKey.SK)!, {
        status: item.Update.ExpressionAttributeValues?.[":accepted"],
        acceptedAt: item.Update.ExpressionAttributeValues?.[":acceptedAt"],
        consentVersion: item.Update.ExpressionAttributeValues?.[":consent"],
      });
    }
    return {};
  });
  const enrollment = createDynamoFamilyEnrollment({ tableName: "synthetic-care", circleId, issuer, now, client: { send } });
  return { ...fixture("consent", enrollment), code, rows, accessKey, inviteKey, send };
}

describe("OAuth account-linking interaction", () => {
  it("reviews a pasted invitation on Open workspace without granting access until separate consent", async () => {
    const { app, code, rows, accessKey, save, interactionFinished } = storedEnrollment(true);
    const initial = await request(app).get(`/interaction/${uid}`).expect(200);
    const csrf = csrfFrom(initial.text);
    const reviewed = await request(app).post(`/interaction/${uid}/consent`).type("form")
      .send({ csrf, invitation: code }).expect(200);
    expect(reviewed.text).toContain("A place in the circle");
    expect(reviewed.text).toContain('name="familyConsent"');
    expect(reviewed.text).toContain('name="invitationProof"');
    expect(rows.has(accessKey.SK)).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(interactionFinished).not.toHaveBeenCalled();
    const proof = reviewed.text.match(/name="invitationProof" value="([^"]+)"/)?.[1];
    await request(app).post(`/interaction/${uid}/consent`).type("form")
      .send({ csrf, invitation: code, invitationProof: proof, familyConsent: familyConsentVersion }).expect(303);
    expect(rows.get(accessKey.SK)).toMatchObject({ status: "active", role: "viewer" });
  });

  it("names the browser workspace when reviewing a browser invitation, without claiming Alexa access", async () => {
    const invitation: Invitation = { circleId: "family-a", circleName: "Evelyn's family", memberId: "maya", name: "Maya", role: "viewer", targetKey: "ACCESS#" + "a".repeat(64), expiresAt: 9999999999, status: "pending" };
    const enrollment = { review: vi.fn(async () => invitation), accept: vi.fn(async () => {}) };
    const { app, save } = fixture("consent", enrollment, true);
    const initial = await request(app).get(`/interaction/${uid}`).expect(200);
    expect(initial.text).toContain("Open your family workspace");
    const reviewed = await request(app).post(`/interaction/${uid}/invitation`).type("form")
      .send({ csrf: csrfFrom(initial.text), invitation: "a".repeat(43) }).expect(200);
    expect(reviewed.text).toContain("Join circle and open workspace");
    expect(reviewed.text).toContain("Check who you are joining and what you can do. Accepting opens this browser workspace within your family permissions.");
    expect(reviewed.text).not.toMatch(/Alexa|voice confirmations/);
    expect(reviewed.text).toContain('name="familyConsent"');
    expect(enrollment.accept).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });

  it("gives neutral recovery instructions for invalid requests from the browser and Alexa clients", async () => {
    for (const browser of [false, true]) {
      const { app, authenticate } = fixture("login", undefined, browser);
      const rejected = await request(app).post(`/interaction/${uid}/login`).type("form")
        .send({ csrf: "forged", username: "owner@example.com", password: "irrelevant password" }).expect(400);
      expect(rejected.text).toBe("This authorization request is no longer valid. Return to the app where you started and sign in again.");
      expect(authenticate).not.toHaveBeenCalled();
    }
  });

  it("rejects pending unbound invitations through real enrollment without offering or granting membership", async () => {
    const { app, code, send, rows, accessKey, inviteKey, save, interactionFinished } = storedEnrollment(false);
    const initial = await request(app).get(`/interaction/${uid}`).expect(200);
    const csrf = csrfFrom(initial.text);
    const review = await request(app).post(`/interaction/${uid}/invitation`).type("form").send({ csrf, invitation: code }).expect(400);
    expect(review.text).toContain("This invitation is unavailable");
    expect(review.text).not.toContain('name="familyConsent"');
    expect(review.text).not.toContain('name="invitationProof"');
    expect(review.text).not.toContain("Join circle and connect");
    const forged = await request(app).post(`/interaction/${uid}/consent`).type("form")
      .send({ csrf, invitation: code, invitationProof: "f".repeat(64), familyConsent: familyConsentVersion }).expect(400);
    expect(forged.text).toContain("This invitation is unavailable");
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
    expect(rows.has(accessKey.SK)).toBe(false); expect(rows.get(inviteKey.SK)?.status).toBe("pending");
    expect(save).not.toHaveBeenCalled(); expect(interactionFinished).not.toHaveBeenCalled();
  });

  it("accepts a roster-bound invitation through real review, proof and consent before saving its OAuth grant", async () => {
    const { app, code, send, rows, accessKey, inviteKey, save, interactionFinished } = storedEnrollment(true);
    const initial = await request(app).get(`/interaction/${uid}`).expect(200);
    const csrf = csrfFrom(initial.text);
    const reviewed = await request(app).post(`/interaction/${uid}/invitation`).type("form").send({ csrf, invitation: code }).expect(200);
    expect(reviewed.text).toContain("Join circle and connect");
    expect(reviewed.text).toContain('name="familyConsent"');
    expect(reviewed.text).toContain("You cannot confirm tasks");
    const proof = reviewed.text.match(/name="invitationProof" value="([^"]+)"/)?.[1];
    expect(proof).toMatch(/^[a-f0-9]{64}$/);
    const form = { csrf, invitation: code, invitationProof: proof, familyConsent: familyConsentVersion };
    await request(app).post(`/interaction/${uid}/consent`).type("form").send({ ...form, familyConsent: "" }).expect(400);
    await request(app).post(`/interaction/${uid}/consent`).type("form").send({ ...form, invitationProof: "f".repeat(64) }).expect(400);
    expect(rows.has(accessKey.SK)).toBe(false); expect(save).not.toHaveBeenCalled();
    save.mockImplementation(async () => {
      expect(rows.get(accessKey.SK)).toMatchObject({ memberId: "maya", name: "Maya", role: "viewer", status: "active",
        acceptedInvitation: inviteKey.SK, consentVersion: familyConsentVersion });
      return "grant-123";
    });
    await request(app).post(`/interaction/${uid}/consent`).type("form").send(form).expect(303).expect("Location", "/resume");
    const transactions = send.mock.calls.map(([command]) => command).filter(command => command instanceof TransactWriteCommand);
    expect(transactions).toHaveLength(1);
    const items = transactions[0]!.input.TransactItems!;
    expect(items).toHaveLength(3);
    expect(items[0]?.ConditionCheck).toMatchObject({ Key: { PK: accessKey.PK, SK: "MEMBER#maya" } });
    expect(items[2]?.Put).toMatchObject({ ConditionExpression: "attribute_not_exists(PK)", Item: { ...accessKey, memberId: "maya", role: "viewer" } });
    expect(rows.get(accessKey.SK)).not.toHaveProperty("canInvite");
    expect(rows.get(inviteKey.SK)?.status).toBe("accepted");
    expect(save).toHaveBeenCalledOnce(); expect(interactionFinished).toHaveBeenCalledOnce();
  });

  it("renders password setup without retaining secrets and rejects mismatched or forged submissions", async () => {
    const { app, authenticate, interactionFinished } = fixture();
    authenticate.mockRejectedValueOnce(new NewPasswordRequiredError());
    const initial = await request(app).get(`/interaction/${uid}`);
    const csrf = csrfFrom(initial.text);
    const setup = await request(app).post(`/interaction/${uid}/login`).type("form")
      .send({ csrf, username: "owner@example.com", password: "Temporary-123!" }).expect(200);
    expect(setup.text).toContain("Make this account yours");
    expect(setup.text).toContain('name="newPassword"');
    expect(setup.text).not.toContain("Temporary-123!");
    const body = { csrf, username: "owner@example.com", password: "Temporary-123!", newPassword: "Permanent-123!", confirmPassword: "Different-123!" };
    const rejected = await request(app).post(`/interaction/${uid}/login`).type("form").send(body).expect(400);
    expect(rejected.text).not.toContain(body.newPassword);
    expect(authenticate).toHaveBeenCalledTimes(1);
    await request(app).post(`/interaction/${uid}/login`).type("form").send({ ...body, csrf: "forged", confirmPassword: body.newPassword }).expect(400);
    expect(authenticate).toHaveBeenCalledTimes(1);
    await request(app).post(`/interaction/${uid}/login`).type("form").send({ ...body, confirmPassword: body.newPassword }).expect(303);
    expect(authenticate).toHaveBeenLastCalledWith(body.username, body.password, body.newPassword);
    expect(interactionFinished).toHaveBeenCalledTimes(1);
  });
  it("reviews a role before explicit acceptance and rejects changed review proofs", async () => {
    const invitation: Invitation = { circleId: "family-a", circleName: "Evelyn <family>", memberId: "maya", name: "Maya", role: "viewer", targetKey: "ACCESS#" + "a".repeat(64), expiresAt: 9999999999, status: "pending" };
    const enrollment = { review: vi.fn(async () => invitation), accept: vi.fn(async () => {}) };
    const { app, save } = fixture("consent", enrollment);
    const initial = await request(app).get(`/interaction/${uid}`);
    const csrf = csrfFrom(initial.text);
    const reviewed = await request(app).post(`/interaction/${uid}/invitation`).type("form").send({ csrf, invitation: "a".repeat(43) }).expect(200);
    expect(reviewed.text).toContain("Evelyn &lt;family&gt;");
    expect(reviewed.text).toContain("You cannot confirm tasks");
    expect(reviewed.text).toContain('name="familyConsent"');
    expect(enrollment.accept).not.toHaveBeenCalled();
    const proof = reviewed.text.match(/name="invitationProof" value="([^"]+)"/)?.[1];
    const form = { csrf, invitation: "a".repeat(43), invitationProof: proof, familyConsent: familyConsentVersion };
    await request(app).post(`/interaction/${uid}/consent`).type("form").send({ ...form, familyConsent: "" }).expect(400);
    await request(app).post(`/interaction/${uid}/consent`).type("form").send({ ...form, invitationProof: "forged" }).expect(400);
    expect(enrollment.accept).not.toHaveBeenCalled();
    await request(app).post(`/interaction/${uid}/consent`).type("form").send(form).expect(303);
    expect(enrollment.accept).toHaveBeenCalledWith("family-account", "a".repeat(43), familyConsentVersion, invitation);
    expect(save).toHaveBeenCalledOnce();
  });

  it("renders a no-cache, CSP-protected family sign-in form", async () => {
    const { app } = fixture();

    const response = await request(app).get(`/interaction/${uid}`).expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).toContain("form-action 'self'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.text).toContain("Bring your care circle together");
    expect(response.text).toContain("autocomplete=\"current-password\"");
    expect(response.text).not.toContain("<script");
  });

  it("authenticates the family account and resumes the provider flow", async () => {
    const { app, authenticate, interactionFinished } = fixture();
    const page = await request(app).get(`/interaction/${uid}`);

    await request(app)
      .post(`/interaction/${uid}/login`)
      .type("form")
      .send({
        csrf: csrfFrom(page.text),
        username: "owner@example.com",
        password: "correct horse battery staple",
      })
      .expect(303)
      .expect("Location", "/resume");

    expect(authenticate).toHaveBeenCalledWith(
      "owner@example.com",
      "correct horse battery staple",
    );
    expect(interactionFinished).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { login: { accountId: "family-account", ts: expect.any(Number) } },
      { mergeWithLastSubmission: false },
    );
  });

  it("uses one safe error for an invalid account and never reflects the password", async () => {
    const { app, authenticate } = fixture();
    authenticate.mockRejectedValueOnce(new InvalidCredentialsError());
    const page = await request(app).get(`/interaction/${uid}`);

    const response = await request(app)
      .post(`/interaction/${uid}/login`)
      .type("form")
      .send({
        csrf: csrfFrom(page.text),
        username: "<owner@example.com>",
        password: "password-that-must-not-appear",
      })
      .expect(401);

    expect(response.text).toContain("We couldn&#39;t sign you in");
    expect(response.text).toContain("&lt;owner@example.com&gt;");
    expect(response.text).not.toContain("password-that-must-not-appear");
  });

  it("rejects a forged form token before checking credentials", async () => {
    const { app, authenticate, interactionFinished } = fixture();

    await request(app)
      .post(`/interaction/${uid}/login`)
      .type("form")
      .send({ csrf: "forged", username: "owner@example.com", password: "irrelevant password" })
      .expect(400);

    expect(authenticate).not.toHaveBeenCalled();
    expect(interactionFinished).not.toHaveBeenCalled();
  });

  it("grants only the exact Kin resource permissions", async () => {
    const { app, interactionFinished, addResourceScope, save } = fixture("consent");
    const page = await request(app).get(`/interaction/${uid}`);

    await request(app)
      .post(`/interaction/${uid}/consent`)
      .type("form")
      .send({ csrf: csrfFrom(page.text) })
      .expect(303);

    expect(addResourceScope).toHaveBeenCalledWith(resourceUri, "mcp:tools mcp:resources");
    expect(save).toHaveBeenCalledOnce();
    expect(interactionFinished).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { consent: { grantId: "grant-123" } },
      { mergeWithLastSubmission: true },
    );
  });

  it("fails closed when consent contains a foreign resource", async () => {
    const { app, details, addResourceScope, save } = fixture("consent");
    details.prompt.details.missingResourceScopes = {
      "https://attacker.example/mcp": ["mcp:tools"],
    };
    const page = await request(app).get(`/interaction/${uid}`);

    await request(app)
      .post(`/interaction/${uid}/consent`)
      .type("form")
      .send({ csrf: csrfFrom(page.text) })
      .expect(400);

    expect(addResourceScope).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("returns an OAuth denial when the family member cancels", async () => {
    const { app, interactionFinished } = fixture();
    const page = await request(app).get(`/interaction/${uid}`);

    await request(app)
      .post(`/interaction/${uid}/cancel`)
      .type("form")
      .send({ csrf: csrfFrom(page.text) })
      .expect(303);

    expect(interactionFinished).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { error: "access_denied", error_description: "The family member declined access" },
      { mergeWithLastSubmission: false },
    );
  });
});
