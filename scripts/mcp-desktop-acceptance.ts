import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { desktopRedirectUri } from "../src/desktop-auth-config.js";
import { createDesktopSession, desktopFetch, desktopResource } from "./lib/mcp-desktop-session.js";

// Intentionally not a general MCP shell: this harness has no care-writing action.
async function main() {
  if (process.argv.length !== 3) throw new Error("Usage: node --import tsx scripts/mcp-desktop-acceptance.ts https://HOST/mcp");
  const resource = desktopResource(process.argv[2]!);
  const callback = new URL(desktopRedirectUri);
  const session = createDesktopSession(resource, url => {
    process.stdout.write(`Open this Kin sign-in URL in your browser and review the desktop-client consent:\n${url.href}\n`);
  });
  let acceptCode!: (code: string) => void, failCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { acceptCode = resolve; failCode = reject; });
  // Prevent an early cancellation/timeout from becoming an unhandled rejection during discovery.
  void code.catch(() => undefined);
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    try {
      const result = session.acceptCallback({ method: request.method, host: request.headers.host,
        url: request.url, origin: request.headers.origin });
      response.end("Kin sign-in returned. You can close this tab and return to the acceptance check.");
      acceptCode(result);
    } catch (error) {
      response.statusCode = 400;
      response.end("This sign-in callback is not valid. Return to the acceptance check; do not paste any code into chat.");
      if (error instanceof Error && error.message.startsWith("Desktop authorization was declined")) failCode(error);
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  const timer = setTimeout(() => failCode(new Error("Desktop sign-in timed out. Start a fresh session.")), 10 * 60 * 1000);
  const fetch = desktopFetch(resource);
  const initial = new Client({ name: "kin-desktop-acceptance", version: "0.1.0" });
  const reader = new Client({ name: "kin-desktop-acceptance", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(resource, { authProvider: session.provider, fetch });
  try {
    server.listen(Number(callback.port), "127.0.0.1");
    await once(server, "listening");
    try { await initial.connect(transport); throw new Error("Expected an independent sign-in challenge, but none was received."); }
    catch (error) { if (!(error instanceof UnauthorizedError)) throw error; }
    await transport.finishAuth(await code);
    await initial.close();
    await reader.connect(new StreamableHTTPClientTransport(resource, { authProvider: session.provider, fetch }));
    const tools = await reader.listTools();
    const resources = await reader.listResources();
    if (!tools.tools.some(tool => tool.name === "show_today") || !resources.resources.some(item => item.uri === "ui://kin/today.html")) {
      throw new Error("Expected Kin MCP capabilities were not returned.");
    }
    const today = await reader.callTool({ name: "show_today", arguments: {} });
    if (today.isError || !today.structuredContent) throw new Error("Authenticated care-plan read failed.");
    const widget = await reader.readResource({ uri: "ui://kin/today.html" });
    if (!widget.contents.some(item => item.uri === "ui://kin/today.html" && "text" in item && item.text.length > 0)) {
      throw new Error("Authenticated MCP widget read failed.");
    }
    // No task names, member identities, record contents, authorization codes or tokens in evidence output.
    process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), resource: resource.href,
      checks: { independentOAuthPkce: true, initialize: true, toolsList: true, resourcesList: true, showToday: true, widgetRead: true },
      careWrites: 0, weeklyModelRequests: 0, physicalEchoEvidence: false })}\n`);
  } finally {
    clearTimeout(timer);
    await Promise.allSettled([initial.close(), reader.close()]);
    session.dispose();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

main().catch(() => {
  // SDK/provider error messages may contain private response bodies. Never print them.
  process.stderr.write("Kin desktop acceptance did not complete. Check the dedicated client is deployed, then start a fresh sign-in. No success is recorded.\n");
  process.exitCode = 1;
});
