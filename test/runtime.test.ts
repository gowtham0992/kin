import { describe, expect, it } from "vitest";
import { createConfiguredApp } from "../src/runtime.js";

describe("Kin runtime configuration", () => {
  it("keeps zero-credential local development available", () => {
    expect(createConfiguredApp({}, { requireOAuth: false })).toBeDefined();
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
});
