import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { KinApiStack } from "../infra/kin-api-stack.js";
import { build } from "esbuild";

it("serves the packaged family workspace through the actual Lambda handler without exposing the demo", async () => {
  const app = new App();
  const stack = new KinApiStack(app, "FamilyBundleTest", {});
  const resources = Template.fromStack(stack).findResources("AWS::Lambda::Function", { Properties: { FunctionName: "kin-mcp-api" } });
  const key = Object.values(resources)[0]!.Properties.Code.S3Key as string;
  const directory = path.join(app.synth().directory, `asset.${key.replace(/\.zip$/, "")}`);
  const files = ["browser-auth.js", "care-client.js", "conversation.css", "duty-rotation.js", "home.css", "home.html", "how-kin-works.html", "invite-client.js", "invite.css", "invite.html", "invite.js", "mcp-client.js", "roster-editor.js", "styles.css", "voice-input.js", "workspace-client.js", "workspace.css", "workspace.js"];
  files.push("install.js", "kin-icon.png", "kin-logo.png", "kin-sw.js", "kin.webmanifest", "push-controls.js", "completion-undo.js", "plan-pause.js");
  files.sort();
  expect((await readdir(path.join(directory, "family"))).sort()).toEqual(files);
  const compiledMcp = await build({ entryPoints: ["simulator/mcp-client.ts"], bundle: true, format: "esm", platform: "browser", target: "es2022",
    minify: true, legalComments: "none", write: false });
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
    const root = await handler(event("/"), {}, () => {});
    expect(root.statusCode).toBe(200);
    expect(new Headers(root.headers).get("cache-control")).toBe("no-store");
    expect(new Headers(root.headers).get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(root.isBase64Encoded ? Buffer.from(root.body, "base64").toString("utf8") : root.body)
      .toBe(await readFile(path.join(directory, "family", "home.html"), "utf8"));
    for (const file of files) {
      const response = await handler(event(`/${file}`), {}, () => {});
      expect(response.statusCode).toBe(200);
      expect(new Headers(response.headers).get("cache-control")).toBe("no-store");
      const body = Buffer.from(response.body, response.isBase64Encoded ? "base64" : "utf8");
      expect(body).toEqual(await readFile(path.join(directory, "family", file)));
      expect(body).toEqual(file === "mcp-client.js" ? Buffer.from(compiledMcp.outputFiles[0]!.text) : await readFile(new URL(`../simulator/${file}`, import.meta.url)));
      if (file.endsWith(".png")) {
        expect(new Headers(response.headers).get("content-type")).toContain("image/png");
        expect(response.isBase64Encoded).toBe(true);
      }
    }
    for (const route of ["/index.html", "/app.js", "/story.html", "/story.js", "/mcp-client.ts", "/%2e%2e%2findex.mjs"]) {
      expect((await handler(event(route), {}, () => {})).statusCode).toBe(404);
    }
    expect((await handler(event("/api/today"), {}, () => {})).statusCode).toBe(401);
    vi.stubEnv("KIN_FAMILY_WORKSPACE_ENABLED", "false");
    const closed = await import(/* @vite-ignore */ `${url}?workspace-disabled`);
    for (const route of ["/", "/home.html", "/home.css", "/invite.html", "/family-auth-config", "/api/today"]) {
      expect((await closed.handler(event(route), {}, () => {})).statusCode).toBe(404);
    }
  } finally { vi.unstubAllEnvs(); }
}, 30_000);
