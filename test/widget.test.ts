import { describe, expect, it } from "vitest";
import { buildWidgetHtml } from "../scripts/build-widget.js";

describe("MCP widget deployment", () => {
  it("bundles the actual App SDK into one HTML resource with no network imports", async () => {
    const html = await buildWidgetHtml();
    expect(html).not.toContain("unpkg.com");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/\bfrom\s*["']@modelcontextprotocol/);
    expect(html).toContain("ui/initialize");
    expect(html).toContain("ui/notifications/tool-result");
    expect(html).toContain("Saved · ask Kin to refresh the plan");
  });
});
