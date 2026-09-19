export const desktopClientId = "kin-desktop-acceptance";
export const desktopRedirectUri = "http://127.0.0.1:43127/oauth/callback";

export interface DesktopAuthConfig { clientId: string; redirectUri: string }

/** One explicitly registered local acceptance client, not general native-client registration. */
export function desktopAuthConfig(input: DesktopAuthConfig = { clientId: desktopClientId, redirectUri: desktopRedirectUri }): DesktopAuthConfig {
  if (input.clientId !== desktopClientId || input.redirectUri !== desktopRedirectUri) {
    throw new Error("Desktop acceptance requires its fixed client identity and exact loopback callback");
  }
  return { clientId: desktopClientId, redirectUri: desktopRedirectUri };
}

export function configuredDesktopAuth(environment: NodeJS.ProcessEnv): DesktopAuthConfig | undefined {
  const enabled = environment.KIN_DESKTOP_AUTH_ENABLED;
  if (enabled === undefined || enabled === "false") return undefined;
  if (enabled !== "true") throw new Error("KIN_DESKTOP_AUTH_ENABLED must be true or false when configured");
  return desktopAuthConfig();
}
