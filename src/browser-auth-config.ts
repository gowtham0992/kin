export interface BrowserAuthConfig { clientId: string; issuer: string; redirectUri: string; resource: string }

export function browserAuthConfig(input: BrowserAuthConfig): BrowserAuthConfig {
  const urls = [input.issuer, input.redirectUri, input.resource].map(value => new URL(value));
  if (urls.some(url => url.protocol !== "https:" || url.username || url.password || url.search || url.hash) ||
      urls.some(url => url.origin !== urls[0]!.origin) || urls[0]!.pathname !== "/" ||
      urls[1]!.pathname !== "/invite.html" || urls[2]!.pathname !== "/mcp" ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(input.clientId)) {
    throw new Error("Browser sign-in requires one HTTPS origin, /invite.html callback, /mcp resource, and a valid client ID");
  }
  return { ...input, issuer: urls[0]!.origin, redirectUri: urls[1]!.href, resource: urls[2]!.href };
}
