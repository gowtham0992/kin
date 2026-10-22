import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "../src/auth.js";
import { createDemoStore } from "../src/domain.js";
import { createHttpApp, type HttpAppOptions } from "../src/http.js";
import { createFamilyConversationService, familyConversationConsentVersion, BudgetExceeded } from "../src/family-conversation.js";

const config = { clientId: "kin-family-browser", issuer: "https://kin.example", redirectUri: "https://kin.example/invite.html", resource: "https://kin.example/mcp" };
function setup() {
  const find = vi.fn(async (): Promise<unknown> => ({ circleId: "family-a", memberId: "maya", name: "Maya", role: "caregiver", status: "active" }));
  const options: HttpAppOptions = {
    serveSimulator: false, serveFamilyWorkspace: true, browserAuth: config,
    accessAuthorizer: { async authorize(header) {
      if (!header) throw new AccessDeniedError(401, "invalid_token");
      return { subject: "subject-a", scopes: new Set(["mcp:tools"]), claims: { iss: config.issuer } };
    } },
    familyAccess: { circleId: "family-a", directory: { find } },
  };
  return { options, find, app: () => createHttpApp(createDemoStore(() => new Date("2026-09-02T08:00:00Z")), undefined, options) };
}

describe("separate family workspace", () => {
  it("links the separate public documentation without changing private workspace access", async () => {
    const app = setup().app();
    const page = await request(app).get("/").expect(200);
    expect(page.text).toContain('<nav class="home-links" aria-label="Learn about Kin">');
    expect(page.text).toMatch(/href="https:\/\/gowtham0992\.github\.io\/kin\/"[^>]*>Docs(?:\s*<span[^>]*>[^<]*<\/span>)?\s*<\/a>/);
    await request(app).get("/api/today").expect(401);
    await request(app).get("/story.html").expect(404);
  });

  it("lets signed-out judges find credential-free instructions without granting family access", async () => {
    const app = setup().app();
    for (const path of ["/", "/invite.html"]) {
      const page = await request(app).get(path).expect(200);
      expect(page.text).toMatch(/href="\/how-kin-works\.html#judges"[^>]*>Judges: start here(?:\s*<span\b[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>)?\s*<\/a>/);
      expect(page.text).not.toMatch(/\bsimulated\b/i);
    }
    const guide = await request(app).get("/how-kin-works.html").expect(200);
    expect(guide.text).toContain('id="judges"');
    expect(guide.text).toMatch(/<section\b[^>]*id="judges"[^>]*tabindex="-1"/);
    expect(guide.text).toContain('href="https://github.com/gowtham0992/kin"');
    expect(guide.text).toContain("npm run demo:story");
    expect(guide.text).toContain("http://127.0.0.1:3030/story.html");
    expect(guide.text).toContain("synthetic");
    expect(guide.text).not.toMatch(/\bsimulated\b/i);
    expect(guide.text).not.toMatch(/(?:password|username)\s*[:=]\s*[^<\s]/i);
    for (const path of ["/api/today", "/api/session", "/api/plan"]) {
      await request(app).get(path).expect(401);
    }
    await request(app).post("/api/tasks/morning-water/confirm")
      .send({ response: "done", requestId: "judge-entry-must-not-save" }).expect(401);
    await request(app).get("/story.html").expect(404);
  });

  it("puts practical first steps and setup limits before expandable coordination details", async () => {
    const page = await request(setup().app()).get("/how-kin-works.html").expect(200);
    expect(page.text).toContain('class="kin-start-steps"');
    expect(page.text).toContain('class="kin-guide-details"');
    expect(page.text).toContain("Before you start");
    expect(page.text).toContain("Phone alerts are off unless delivery is enabled");
    expect(page.text).toContain("not native Alexa+ toolkit integration");
    expect(page.text).toContain("not emergency monitoring");
    expect(page.text).toContain("script-src 'none'");
  });

  it("keeps a public alias separate from the existing authenticated workspace", async () => {
    const f = setup();
    f.options.publicSiteOrigin = "https://public.kin.example";
    const app = f.app();
    await request(app).get("/").set("host", "public.kin.example").expect(200);
    const entry = await request(app).get("/invite.html?code=do-not-forward&next=https://evil.example")
      .set("host", "public.kin.example").expect(302);
    expect(entry.headers.location).toBe(config.redirectUri);
    expect(entry.headers["cache-control"]).toBe("no-store");
    expect(entry.headers["referrer-policy"]).toBe("no-referrer");
    await request(app).get("/invite.html").set("host", "kin.example").expect(200);
    await request(app).get("/invite.html").set("host", "kin.example")
      .set("x-forwarded-host", "public.kin.example").expect(200);
    await request(app).get("/api/today").set("host", "public.kin.example").expect(401);
  });

  it.each(["http://public.kin.example", "https://public.kin.example/path", "https://user@public.kin.example", "https://public.kin.example?x=1"])(
    "rejects invalid public site origin %s", origin => {
      const f = setup(); f.options.publicSiteOrigin = origin;
      expect(() => f.app()).toThrow(/Public site/);
    });

  it("explains invitation acceptance through Kin sign-in without requiring Alexa", async () => {
    const page = await request(setup().app()).get("/invite.html").expect(200);
    expect(page.text).toContain("sign in to Kin, choose Review invitation, and review their permissions before accepting");
    expect(page.text).not.toContain("when linking Alexa");
    expect(page.text).toContain("Closing a workspace session does not remove family membership");
    expect(page.text).toContain("No access has been granted yet");
  });

  it("keeps optional natural language disabled and requires consent for every model request", async () => {
    const fixture = setup();
    const body = { message: "I had some water", mode: "bedrock", transferConsent: true, disclosureVersion: familyConversationConsentVersion };
    await request(fixture.app()).post("/api/conversation").set("authorization", "Bearer test").send(body).expect(503);
    const generate = vi.fn(async () => ({ action: "confirm", taskId: "morning-water", response: "done" }));
    const reserve = vi.fn(async () => {});
    fixture.options.familyConversation = createFamilyConversationService({ generate, budget: { reserve } });
    const app = fixture.app();
    await request(app).post("/api/conversation").send(body).expect(401);
    for (const invalid of [ { ...body, transferConsent: false }, { ...body, transferConsent: undefined },
      { ...body, disclosureVersion: "outdated" }, { ...body, memberId: "theo" }, { ...body, mode: undefined } ]) {
      await request(app).post("/api/conversation").set("authorization", "Bearer test").send(invalid).expect(400);
    }
    await request(app).post("/api/conversation").set("authorization", "Bearer test").send({ message: "Show today" }).expect(200);
    expect(generate).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    const session = await request(app).get("/api/session").set("authorization", "Bearer test").expect(200);
    expect(session.body.conversation).toEqual({ naturalLanguage: true, consentVersion: familyConversationConsentVersion });
    const result = await request(app).post("/api/conversation").set("authorization", "Bearer test").send(body).expect(200);
    expect(result.body).toMatchObject({ action: "confirm", mode: "bedrock", task: { id: "morning-water" } });
    expect(reserve).toHaveBeenCalledExactlyOnceWith({ circleId: "family-a", memberId: "maya" });
    const today = await request(app).get("/api/today").set("authorization", "Bearer test");
    expect(today.body.summary.completed).toBe(0);
    fixture.find.mockResolvedValue({ circleId: "family-a", memberId: "theo", name: "Theo", role: "viewer", status: "active" });
    await request(app).post("/api/conversation").set("authorization", "Bearer test").send(body).expect(403);
    const viewer = await request(app).get("/api/session").set("authorization", "Bearer test");
    expect(viewer.body.conversation).toBeUndefined(); expect(generate).toHaveBeenCalledTimes(1);
  });
  it("sanitizes model failures and limits without making a model call when quota is denied", async () => {
    const fixture = setup(), generate = vi.fn(async () => { throw new Error("PRIVATE PROVIDER CONTENT"); });
    const reserve = vi.fn(async () => {});
    fixture.options.familyConversation = createFamilyConversationService({ generate, budget: { reserve } });
    const app = fixture.app(), body = { message: "I had some water", mode: "bedrock", transferConsent: true, disclosureVersion: familyConversationConsentVersion };
    await request(app).post("/api/conversation").set("authorization", "Bearer test").send(body).expect(503, { error: "natural_language_unavailable" });
    reserve.mockRejectedValueOnce(new BudgetExceeded());
    const limited = await request(app).post("/api/conversation").set("authorization", "Bearer test").send(body).expect(429, { error: "natural_language_limited" });
    expect(limited.headers["retry-after"]).toBe("60"); expect(limited.headers["cache-control"]).toBe("no-store");
    reserve.mockRejectedValueOnce(new Error("UNKNOWN BUDGET OUTCOME"));
    await request(app).post("/api/conversation").set("authorization", "Bearer test").send(body).expect(503, { error: "natural_language_unavailable" });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("scopes reviewed handoffs to the member and retains the original receipt on retry", async () => {
    const fixture = setup(), app = fixture.app();
    const circle = await request(app).get("/api/circle").set("authorization", "Bearer test").expect(200);
    const old = circle.body.assignments[0], next = old.memberId === "maya" ? "theo" : "maya";
    const body = { date: old.date, memberId: next, expectedMemberId: old.memberId, requestId: "review-duty-0001" };
    await request(app).put("/api/circle/duty").send(body).expect(401);
    const saved = await request(app).put("/api/circle/duty").set("authorization", "Bearer test").send(body).expect(200);
    expect(saved.body.requestId).toBe(body.requestId);
    expect(saved.body.assignments.find((day: { date: string }) => day.date === body.date)).toMatchObject({ memberId: next, changedBy: "Maya" });
    await request(app).put("/api/circle/duty").set("authorization", "Bearer test").send(body).expect(200);
    await request(app).put("/api/circle/duty").set("authorization", "Bearer test").send({ ...body, requestId: "review-duty-0002" }).expect(409);
    await request(app).put("/api/circle/duty").set("authorization", "Bearer test").send({ ...body, actor: "Fake name" }).expect(400);
    await request(app).put("/api/circle/duty").set("authorization", "Bearer test").send({ date: body.date, memberId: next, expectedMemberId: null }).expect(400);
    fixture.find.mockResolvedValue({ circleId: "family-a", memberId: "theo", name: "Theo", role: "viewer", status: "active" });
    await request(app).put("/api/circle/duty").set("authorization", "Bearer test").send(body).expect(403);
  });
  it("protects request interpretation and never uses the demo model for family text", async () => {
    const fixture = setup(); const generate = vi.fn(); fixture.options.demoIntentGenerator = generate;
    const app = fixture.app();
    await request(app).post("/api/conversation").send({ message: "Show today" }).expect(401);
    const proposal = await request(app).post("/api/conversation").set("authorization", "Bearer test").send({ message: "Done: Drink a glass of water" }).expect(200);
    expect(proposal.body).toMatchObject({ action: "confirm", expected: { state: "scheduled", confirmedBy: null } });
    expect(generate).not.toHaveBeenCalled();
    const before = await request(app).get("/api/today").set("authorization", "Bearer test");
    expect(before.body.summary.completed).toBe(0);
    await request(app).post("/api/conversation").set("authorization", "Bearer test").send({ message: "x".repeat(801) }).expect(400);
    fixture.find.mockResolvedValue({ circleId: "family-a", memberId: "theo", name: "Theo", role: "viewer", status: "active" });
    await request(app).post("/api/conversation").set("authorization", "Bearer test").send({ message: "Show today" }).expect(403);
    fixture.find.mockResolvedValue(null);
    await request(app).post("/api/conversation").set("authorization", "Bearer test").send({ message: "Show today" }).expect(403);
  });
  it("saves a reviewed family request with server attribution and rejects a competing stale review", async () => {
    const app = setup().app();
    const proposal = await request(app).post("/api/conversation").set("authorization", "Bearer test").send({ message: "Done: Drink a glass of water" });
    const body = { response: "done", actor: "Forged name", requestId: "family-review-1", expected: proposal.body.expected };
    const saved = await request(app).post("/api/tasks/morning-water/confirm").set("authorization", "Bearer test").send(body).expect(201);
    expect(saved.body.confirmation.actor).toBe("Maya");
    await request(app).post("/api/tasks/morning-water/confirm").set("authorization", "Bearer test").send(body).expect(200);
    const stale = await request(app).post("/api/tasks/morning-water/confirm").set("authorization", "Bearer test").send({ ...body, requestId: "family-review-2", response: "not_yet" }).expect(409);
    expect(stale.body.error).toBe("review_conflict");
  });
  it("returns only the caller's display identity and effective permissions", async () => {
    const fixture = setup(); const app = fixture.app();
    await request(app).get("/api/session").expect(401);
    const response = await request(app).get("/api/session").set("authorization", "Bearer test").expect(200);
    expect(response.body).toEqual({ name: "Maya", memberId: "maya", role: "caregiver", features: { completionUndo: true, completionUndoWindowSeconds: 300 }, permissions: { confirm: true, manageDuty: true, pausePlan: true, invite: false } });
    expect(response.headers["cache-control"]).toBe("no-store");
    fixture.find.mockResolvedValue({ circleId: "family-a", memberId: "theo", name: "Theo", role: "viewer", status: "active", canInvite: true });
    const viewer = await request(app).get("/api/session").set("authorization", "Bearer test").expect(200);
    expect(viewer.body.permissions).toEqual({ confirm: false, manageDuty: false, pausePlan: false, invite: false });
  });
  it("serves only the family asset allowlist with private-page protections", async () => {
    const app = setup().app();
    const home = await request(app).get("/").expect(200);
    expect(home.text).toContain('href="/invite.html#ask"');
    expect(home.text).toContain('href="/invite.html#today"');
    expect(home.text).toContain("Alexa + real MCP");
    expect(home.text).toContain("Kin’s web conversation uses real MCP calls.");
    expect(home.text).toContain("classic Alexa development skill");
    expect(home.text).toContain("not native Alexa+ toolkit integration");
    expect(home.text).not.toContain("not connected to Alexa or an Echo device");
    expect(home.text).not.toContain("<script");
    expect(home.text).not.toContain('href="/story.html"');
    expect(home.headers["cache-control"]).toBe("no-store");
    expect(home.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    for (const asset of ["home.html", "home.css", "conversation.css", "invite.html", "invite.js", "invite.css", "invite-client.js", "browser-auth.js", "styles.css", "mcp-client.js", "completion-undo.js"]) {
      const response = await request(app).get(`/${asset}`).expect(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }
    for (const path of ["/index.html", "/app.js", "/story.html", "/story.js", "/story.css", "/package.json", "/%2e%2e%2fpackage.json", "/.env"]) {
      await request(app).get(path).expect(404);
    }
    await request(app).get("/family-auth-config").expect(200, config);
  });

  it("allows member API reads without enabling the simulator and rechecks revocation", async () => {
    const fixture = setup(); const app = fixture.app();
    await request(app).get("/api/today").expect(401);
    expect(fixture.find).not.toHaveBeenCalled();
    await request(app).get("/api/today").set("authorization", "Bearer test").expect(200);
    fixture.find.mockResolvedValue(null);
    await request(app).get("/api/today").set("authorization", "Bearer test").expect(403);
  });

  it("refuses workspace startup without every security prerequisite or with demo serving", () => {
    const { options } = setup();
    for (const key of ["accessAuthorizer", "familyAccess", "browserAuth"] as const) {
      expect(() => createHttpApp(createDemoStore(), undefined, { ...options, [key]: undefined })).toThrow("Family workspace requires");
    }
    expect(() => createHttpApp(createDemoStore(), undefined, { ...options, serveSimulator: true })).toThrow("Family workspace cannot");
  });
});
