import { describe, it, expect } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
import { createHttpApp } from "../src/http.js";
import { createDemoStore } from "../src/domain.js";
import { AccessDeniedError } from "../src/auth.js";
import type { BrowserSession } from "../src/browser-session.js";
import { createLambdaHttpHandler } from "../src/lambda-http.js";
const origin = "https://kin.example";
function fixture() {
  const sessions = new Map<string, BrowserSession>();
  let active = true;
  const app = createHttpApp(createDemoStore(), undefined, {
    serveSimulator: false, serveFamilyWorkspace: true,
    canonicalMcpUri: `${origin}/mcp`, authorizationServer: origin,
    browserAuth: { clientId: "kin-family-browser", issuer: origin, redirectUri: `${origin}/invite.html`, resource: `${origin}/mcp` },
    browserSessions: { get: async id => sessions.get(id) ?? null, put: async (id,s) => { sessions.set(id,s); }, revoke: async id => { sessions.delete(id); } },
    accessAuthorizer: { authorize: async header => {
      if (header !== "Bearer synthetic") throw new AccessDeniedError(401, "invalid_token");
      return { subject: "one", scopes: new Set(["mcp:tools"]), claims: { client_id: "kin-family-browser", exp: Math.floor(Date.now()/1000)+3600 } };
    } },
    familyAccess: { circleId: "demo-family", directory: { find: async () => active ? { circleId: "demo-family", memberId: "maya", name: "Maya", role: "caregiver", status: "active" } : null } },
  });
  const call = (method: "get"|"post"|"delete", path = "/browser-session") => request(app)[method](path).set("origin",origin).set("x-kin-workspace","1");
  const login = async () => {
    const result = await call("post").set("authorization","Bearer synthetic");
    expect(result.status).toBe(200);
    const cookie = result.headers["set-cookie"]![0]!.split(";")[0] as string;
    return { result, cookie, binding: createHash("sha256").update(cookie.split("=")[1]!).digest("hex") };
  };
  return { app, call, login, sessions, revoke: () => { active=false; } };
}
describe("refresh-safe browser session", () => {
  it("round-trips the cookie through the production Lambda HTTP adapter", async () => {
    const f=fixture();const handler=createLambdaHttpHandler(f.app);
    const event={version:"2.0",routeKey:"$default",rawPath:"/browser-session",rawQueryString:"",
      headers:{host:"kin.example",origin,"x-kin-workspace":"1",authorization:"Bearer synthetic"},
      requestContext:{http:{method:"POST",path:"/browser-session",sourceIp:"127.0.0.1"},stage:"$default"},isBase64Encoded:false};
    const created=await handler(event,{} as never,()=>{});expect(created.statusCode).toBe(200);
    const cookie=created.cookies[0].split(";")[0];
    const restored=await handler({...event,headers:{host:"kin.example",origin,"x-kin-workspace":"1"},cookies:[cookie],
      requestContext:{...event.requestContext,http:{...event.requestContext.http,method:"GET"}}},{} as never,()=>{});
    expect(restored.statusCode).toBe(200);expect(JSON.parse(restored.body).binding).toMatch(/^[a-f0-9]{64}$/);
  });
  it("restores without a bearer in the browser, with HttpOnly host-only cookies", async () => {
    const f=fixture(); const {result,cookie,binding}=await f.login();
    expect(result.headers["set-cookie"]![0]).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    expect(result.headers["set-cookie"]![0]).not.toContain("Domain=");
    expect(JSON.stringify(result.body)).not.toContain("synthetic");
    expect((await f.call("get").set("cookie",cookie)).status).toBe(200);
    expect((await f.call("get","/api/today").set("cookie",cookie).set("x-kin-session",binding)).status).toBe(200);
  });
  it("revokes server state on logout, including a replay of the former cookie", async () => {
    const f=fixture();const {cookie}=await f.login();
    expect((await f.call("delete").set("cookie",cookie)).status).toBe(204);
    expect((await f.call("get").set("cookie",cookie)).status).toBe(401);
  });
  it("preserves authenticated MCP discovery through the cookie boundary", async () => {
    const f=fixture();const {cookie,binding}=await f.login();
    const result=await f.call("post","/mcp").set("cookie",cookie).set("x-kin-session",binding)
      .set("accept","application/json, text/event-stream").send({jsonrpc:"2.0",id:1,method:"initialize",
        params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"synthetic-browser",version:"1"}}});
    expect(result.status).toBe(200);expect(result.text).toContain("serverInfo");
  });
  it("does not downgrade an explicitly invalid bearer to a valid cookie", async () => {
    const f=fixture();const {cookie,binding}=await f.login();
    const result=await f.call("get","/api/today").set("cookie",cookie).set("x-kin-session",binding).set("authorization","Bearer invalid");
    expect(result.status).toBe(401);
  });
  it("checks current membership after refresh and on protected reads", async () => {
    const f=fixture(); const {cookie,binding}=await f.login();f.revoke();
    expect((await f.call("get").set("cookie",cookie)).status).toBe(403);
    expect((await f.call("get","/api/today").set("cookie",cookie).set("x-kin-session",binding)).status).toBe(403);
  });
  it("rejects expired stored sessions even before database TTL cleanup", async () => {
    const f=fixture(); const {cookie}=await f.login(); for(const s of f.sessions.values())s.expiresAt=0;
    expect((await f.call("get").set("cookie",cookie)).status).toBe(401);
  });
  it("rejects a stale tab binding after another tab signs in", async () => {
    const f=fixture();const first=await f.login();const next=await f.login();
    expect((await f.call("get","/api/today").set("cookie",next.cookie).set("x-kin-session",first.binding)).status).toBe(401);
  });
  it("rejects cross-site, missing-CSRF-header, missing-origin writes and duplicate cookies", async () => {
    const f=fixture();const {cookie}=await f.login();
    expect((await f.call("delete").set("cookie",cookie).set("origin","https://evil.example")).status).toBe(403);
    expect((await request(f.app).get("/browser-session").set("cookie",cookie)).status).toBe(403);
    expect((await request(f.app).delete("/browser-session").set("cookie",cookie).set("x-kin-workspace","1")).status).toBe(403);
    expect((await f.call("get").set("cookie",`${cookie}; ${cookie}`)).status).toBe(401);
  });
});
