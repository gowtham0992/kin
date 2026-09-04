import { describe, expect, it } from "vitest";
import request from "supertest";
import { createConfiguredApp } from "../src/runtime.js";

describe("Kin runtime configuration", () => {
  it("keeps zero-credential local development available", () => {
    expect(createConfiguredApp({}, { requireOAuth: false })).toBeDefined();
  });

  it("serves only a deliberate 503 while the public rollout gate is closed", async () => {
    const app = createConfiguredApp({ KIN_PUBLIC_API_ENABLED: "false" }, { requireOAuth: true });
    const response = await request(app).get("/health").expect(503);

    expect(response.body).toEqual({ error: "Kin's public API is temporarily unavailable" });
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("fails closed when a public runtime has no OAuth configuration", () => {
    expect(() => createConfiguredApp({}, { requireOAuth: true })).toThrow(
      "OAuth configuration is required on the public Kin runtime",
    );
  });

  it("rejects partially configured OAuth", () => {
    expect(() => createConfiguredApp({
      KIN_MCP_CANONICAL_URI: "https://api.kin.example/mcp",
    })).toThrow("must be configured together");
  });

  it("rejects two competing canonical resource sources", () => {
    expect(() => createConfiguredApp({
      KIN_MCP_CANONICAL_URI: "https://api.kin.example/mcp",
      KIN_MCP_RESOURCE_PARAMETER: "/kin/mcp/canonical-uri",
    })).toThrow("not both");
  });
});
