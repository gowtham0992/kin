import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
const { createBrowserAuth } = await import(new URL("../simulator/browser-auth.js", import.meta.url).href);
const origin="https://kin.example";
function fixture() {
  let connected=false, clock=1000000;
  const data=new Map<string,string>();
  const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)};
  const config={clientId:"kin-family-browser",issuer:origin,redirectUri:origin+"/invite.html",resource:origin+"/mcp",sessionMode:"cookie"};
  const request=vi.fn(async (url:string, options:RequestInit) => {
    if(url==="/token")return Response.json({access_token:"synthetic",token_type:"Bearer",expires_in:3600,scope:"mcp:tools"});
    if(url==="/browser-session") {
      expect(options.credentials).toBe("same-origin");
      expect(new Headers(options.headers).get("x-kin-workspace")).toBe("1");
      if(options.method==="DELETE"){connected=false;return new Response(null,{status:204});}
      if(options.method==="POST"){connected=true;return Response.json({expiresAt:4600000});}
      return connected ? Response.json({expiresAt:4600000,binding:"a".repeat(64)}) : new Response(null,{status:401});
    }
    return Response.json({ok:true});
  });
  const make=()=>createBrowserAuth({origin,config,storage,request,cryptoApi:webcrypto,now:()=>clock});
  const login=async () => {const a=make();const start=new URL(await a.start("week"));await a.complete(`${config.redirectUri}?code=synthetic&iss=${encodeURIComponent(origin)}&state=${start.searchParams.get("state")}`);return a;};
  return {make,login,request,data,expire:()=>{clock=4600001;}};
}
describe("cookie session browser lifecycle",()=>{
  it("renews through prompt=none with fresh PKCE without deleting the existing browser session", async () => {
    const f=fixture(), auth=f.make();
    expect(auth.canRenew).toBe(true);
    const start=new URL(await auth.start("week", { silent:true }));
    expect(start.searchParams.get("prompt")).toBe("none");
    expect(start.searchParams.get("code_challenge_method")).toBe("S256");
    expect(f.request).not.toHaveBeenCalled();
    await auth.complete(`${origin}/invite.html?code=synthetic&iss=${encodeURIComponent(origin)}&state=${start.searchParams.get("state")}`);
    expect(auth.connected).toBe(true); expect(auth.returnView).toBe("week");
    expect(f.request.mock.calls.some(([, options])=>options.method==="DELETE")).toBe(false);
  });
  it.each(["login_required", "consent_required", "interaction_required"])("stops silent renewal on %s without a token exchange or redirect loop", async error => {
    const f=fixture(), auth=f.make(), start=new URL(await auth.start("week", { silent:true }));
    const next=f.make();
    expect(await next.complete(`${origin}/invite.html?error=${error}&iss=${encodeURIComponent(origin)}&state=${start.searchParams.get("state")}`)).toBe(false);
    expect(next.canRenew).toBe(false); expect(next.connected).toBe(false); expect(f.request).not.toHaveBeenCalled();
    expect(new URL(await next.start()).searchParams.get("prompt")).toBe("login consent");
  });
  it("does not silently reopen an explicitly closed workspace",async()=>{
    const f=fixture(), auth=await f.login(); await auth.disconnect();
    const next=f.make(); expect(next.canRenew).toBe(false);
    await expect(next.start("today", { silent:true })).rejects.toThrow();
    await next.start(); expect(f.data.has("kin.workspace-closed")).toBe(false);
  });
  it("rejects forged renewal errors and consumed callbacks",async()=>{
    const f=fixture(), auth=f.make(), start=new URL(await auth.start("today", { silent:true }));
    const forged=`${origin}/invite.html?error=login_required&iss=${encodeURIComponent(origin)}&state=wrong`;
    await expect(auth.complete(forged)).rejects.toThrow();
    await expect(auth.complete(`${origin}/invite.html?code=synthetic&iss=${encodeURIComponent(origin)}&state=${start.searchParams.get("state")}`)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it("restores after refresh without replaying OAuth or putting tokens in storage",async()=>{
    const f=fixture();const first=await f.login();expect(first.connected).toBe(true);first.suspend();
    const second=f.make();expect(await second.complete(origin+"/invite.html#week")).toBe(false);
    expect(second.connected).toBe(true);expect(f.data.size).toBe(0);
    await second.request("/api/today");const init=f.request.mock.calls.at(-1)![1];
    expect(new Headers(init.headers).has("authorization")).toBe(false);expect(init.credentials).toBe("same-origin");
    expect(f.request.mock.calls.filter(([url])=>url==="/token")).toHaveLength(1);
  });
  it("closes the server session and cannot restore it on the next refresh",async()=>{
    const f=fixture();const auth=await f.login();await auth.disconnect();const next=f.make();
    await next.complete(origin+"/invite.html");expect(next.connected).toBe(false);
  });
  it("does not silently fall back to a bearer session when cookie creation fails",async()=>{
    const f=fixture();const auth=f.make();const start=new URL(await auth.start());
    f.request.mockImplementationOnce(async()=>Response.json({access_token:"synthetic",token_type:"Bearer",expires_in:3600,scope:"mcp:tools"}));
    f.request.mockImplementationOnce(async()=>new Response(null,{status:503}));
    await expect(auth.complete(`${origin}/invite.html?code=synthetic&iss=${encodeURIComponent(origin)}&state=${start.searchParams.get("state")}`)).rejects.toThrow();
    expect(auth.connected).toBe(false);
  });
  it("refuses expired sessions and cross-origin token or cookie forwarding",async()=>{
    const f=fixture();const auth=await f.login();await expect(auth.request("https://evil.example/api/today")).rejects.toThrow();
    f.expire();await expect(auth.request("/api/today")).rejects.toThrow();
  });
});
