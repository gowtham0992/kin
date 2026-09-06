import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "../src/auth.js";
import { createDemoStore } from "../src/domain.js";
import { createHttpApp, type HttpAppOptions } from "../src/http.js";

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
  it("returns only the caller's display identity and effective permissions", async () => {
    const fixture = setup(); const app = fixture.app();
    await request(app).get("/api/session").expect(401);
    const response = await request(app).get("/api/session").set("authorization", "Bearer test").expect(200);
    expect(response.body).toEqual({ name: "Maya", memberId: "maya", role: "caregiver", permissions: { confirm: true, manageDuty: true, invite: false } });
    expect(response.headers["cache-control"]).toBe("no-store");
    fixture.find.mockResolvedValue({ circleId: "family-a", memberId: "theo", name: "Theo", role: "viewer", status: "active", canInvite: true });
    const viewer = await request(app).get("/api/session").set("authorization", "Bearer test").expect(200);
    expect(viewer.body.permissions).toEqual({ confirm: false, manageDuty: false, invite: false });
  });
  it("serves only the family asset allowlist with private-page protections", async () => {
    const app = setup().app();
    await request(app).get("/").expect(302).expect("location", "/invite.html");
    for (const asset of ["invite.html", "invite.js", "invite.css", "invite-client.js", "browser-auth.js", "styles.css"]) {
      const response = await request(app).get(`/${asset}`).expect(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }
    for (const path of ["/index.html", "/app.js", "/package.json", "/%2e%2e%2fpackage.json", "/.env"]) {
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
