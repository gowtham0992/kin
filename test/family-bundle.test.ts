import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { KinApiStack } from "../infra/kin-api-stack.js";

it("serves the packaged family workspace through the actual Lambda handler without exposing the demo", async () => {
  const app = new App();
  const stack = new KinApiStack(app, "FamilyBundleTest", {});
  const resources = Template.fromStack(stack).findResources("AWS::Lambda::Function", { Properties: { FunctionName: "kin-mcp-api" } });
  const key = Object.values(resources)[0]!.Properties.Code.S3Key as string;
  const directory = path.join(app.synth().directory, `asset.${key.replace(/\.zip$/, "")}`);
  const files = ["browser-auth.js", "care-client.js", "invite-client.js", "invite.css", "invite.html", "invite.js", "styles.css", "workspace-client.js", "workspace.css", "workspace.js"];
  expect((await readdir(path.join(directory, "family"))).sort()).toEqual(files);
  const environment = {
    KIN_PUBLIC_API_ENABLED: "true", KIN_SERVE_SIMULATOR: "false", KIN_FAMILY_WORKSPACE_ENABLED: "true",
    KIN_BROWSER_AUTH_ENABLED: "true", KIN_BROWSER_CLIENT_ID: "kin-family-browser",
    KIN_BROWSER_REDIRECT_URI: "https://kin.example/invite.html", KIN_OAUTH_ISSUER: "https://kin.example",
    KIN_OAUTH_JWKS_URI: "https://kin.example/jwks", KIN_MCP_CANONICAL_URI: "https://kin.example/mcp",
    KIN_MCP_RESOURCE_PARAMETER: "", KIN_DYNAMODB_TABLE: "synthetic-test", KIN_INVITATION_ISSUING_ENABLED: "false",
  };
  const event = (rawPath: string) => ({ version: "2.0", routeKey: "$default", rawPath, rawQueryString: "",
    headers: { host: "kin.example" }, requestContext: { http: { method: "GET", path: rawPath, sourceIp: "127.0.0.1" }, stage: "$default" }, isBase64Encoded: false });
  try {
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
    const url = pathToFileURL(path.join(directory, "index.mjs")).href;
    const { handler } = await import(/* @vite-ignore */ url);
    for (const file of files) {
      const response = await handler(event(`/${file}`), {}, () => {});
      expect(response.statusCode).toBe(200);
      expect(new Headers(response.headers).get("cache-control")).toBe("no-store");
      const body = response.isBase64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
      expect(body).toBe(await readFile(path.join(directory, "family", file), "utf8"));
      expect(body).toBe(await readFile(new URL(`../simulator/${file}`, import.meta.url), "utf8"));
    }
    for (const route of ["/index.html", "/app.js", "/%2e%2e%2findex.mjs"]) {
      expect((await handler(event(route), {}, () => {})).statusCode).toBe(404);
    }
    expect((await handler(event("/api/today"), {}, () => {})).statusCode).toBe(401);
    vi.stubEnv("KIN_FAMILY_WORKSPACE_ENABLED", "false");
    const closed = await import(/* @vite-ignore */ `${url}?workspace-disabled`);
    for (const route of ["/invite.html", "/family-auth-config", "/api/today"]) {
      expect((await closed.handler(event(route), {}, () => {})).statusCode).toBe(404);
    }
  } finally { vi.unstubAllEnvs(); }
}, 30_000);
