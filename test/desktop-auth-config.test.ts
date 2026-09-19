import { expect, it } from "vitest";
import { desktopAuthConfig, desktopClientId, desktopRedirectUri } from "../src/desktop-auth-config.js";
import { createKinOAuthProvider } from "../src/oauth-provider.js";

it.each([
  "http://127.0.0.1:43128/oauth/callback", "http://localhost:43127/oauth/callback", "http://[::1]:43127/oauth/callback",
  "http://127.0.0.1:43127/*", "http://127.0.0.1:43127/oauth/callback#fragment", "http://127.0.0.1:43127/oauth/callback?next=other",
  "http://user:password@127.0.0.1:43127/oauth/callback", "https://foreign.example/callback", " http://127.0.0.1:43127/oauth/callback",
])("rejects desktop callback configuration %s", redirectUri => {
  expect(() => desktopAuthConfig({ clientId: desktopClientId, redirectUri })).toThrow("exact loopback callback");
  // The provider itself must validate; callers cannot bypass the config helper.
  expect(() => createKinOAuthProvider({ issuer: "https://desktop-auth.example", resourceUri: "https://desktop-auth.example/mcp",
    jwks: { keys: [{}] }, cookieKeys: ["a".repeat(32), "b".repeat(32)], adapter: class {},
    serviceClient: { clientId: "synthetic-service-client", clientSecret: "synthetic-service-secret" },
    desktopClient: { clientId: desktopClientId, redirectUri },
  })).toThrow("exact loopback callback");
});

it.each(["kin-family-browser", "kin-desktop-acceptance ", "another-desktop-client"])("rejects desktop identity substitution %s", clientId => {
  expect(() => desktopAuthConfig({ clientId, redirectUri: desktopRedirectUri })).toThrow("fixed client identity");
});
