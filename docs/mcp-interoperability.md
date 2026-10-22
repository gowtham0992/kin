# Connect an MCP client to Kin

Kin exposes a self-hosted MCP server over Streamable HTTP at `POST /mcp`,
compatible with protocol `2025-11-25`. Authorized clients can read the plan,
submit a reviewed reply and retrieve an evidence-linked brief. The Today
resource includes an MCP Apps widget.

Production access requires both a valid resource-bound OAuth token and the
appropriate active family membership. Discovery is not registration, and
knowing the endpoint or a roster name does not grant care access.

## Choose the discovery profile deliberately

Set `KIN_MCP_AUTH_MODE=standard` for ordinary OAuth-aware MCP clients. Leaving
it unset selects `alexa`; blank or unrecognized values fail configuration.
One runtime selects one profile, rather than negotiating a profile per caller.

The authenticated runtime needs a canonical HTTPS MCP resource, issuer and
JWKS URI. `KIN_OAUTH_AUTHORIZATION_SERVER` can specify the advertised
authorization server; otherwise the issuer is used. Configure the resource
through `KIN_MCP_CANONICAL_URI` or `KIN_MCP_RESOURCE_PARAMETER`, never both.
See the [developer guide](development.md) for the full configuration boundary.

The standard profile serves protected-resource metadata at both
`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`. It advertises `mcp:tools` and
`mcp:resources`, and token failures include a `WWW-Authenticate` challenge
pointing to the configured metadata URL. Insufficient-scope responses name
the required operation scope. Missing or revoked membership instead returns
`403 family_access_denied`, without suggesting a scope upgrade.

The `alexa` profile advertises all three recognized scopes, including the
separate `mcp:service` grant, and retains its no-challenge response contract.
Selecting that profile does not establish native Alexa+ Toolkit access.

## Register the client before authorization

The provider uses preregistered clients with exact approved callback URIs;
Kin does not offer dynamic client registration or arbitrary callback support.
Its authorization-code flow requires PKCE and explicit user consent. Ordinary
clients must request Kin's exact resource and user-level scopes. Never place
a service client secret in a browser or reuse an unrelated application's
client identity.

Browser, classic Echo, Alexa account-linking and desktop clients have separate
identities and configuration. The optional desktop acceptance harness has one
fixed loopback callback; it is not a general native-client registration system.
The classic Echo client has narrowly scoped compatibility handling for its
resource parameter and permits only `mcp:tools`. Those exceptions do not apply
to arbitrary clients.

OAuth grants do not create circle membership. The server verifies current
membership and role when a user-scoped client accesses Kin, including protocol
and tool-metadata requests. Service-only grants cannot read or change care data.

## Scopes limit operations; membership limits family access

`initialize`, `notifications/initialized`, `ping` and `tools/list` accept a
verified token with any recognized MCP scope. They expose protocol/static tool
metadata, not care state. Other requests need their operation's scope; unknown
tool names and batch requests do not bypass permission checks.

| Verified token scope | Protocol/tool metadata | Care-tool calls | Widget resources |
| --- | --- | --- | --- |
| `mcp:service` only | Allowed without family membership | Denied | Denied |
| `mcp:tools` only | Active membership required | Membership and role required | Denied |
| `mcp:resources` only | Active membership required | Denied | Active membership required |
| Both user scopes | Active membership required | Membership and role required | Active membership required |

Signature, issuer, audience, expiration and subject checks apply before these
rules. Unknown scopes do not grant initialization. A user token that also
contains `mcp:service` still undergoes the user-membership check.

## Preserve review and retry semantics

Reading a plan or interpreting language is not permission to save a reply.
Show the selected check-in and proposed response, obtain confirmation, and
submit the exact reviewed snapshot with a unique request ID. If the result is
uncertain, retry that same request instead of generating a new ID. Changed
task state requires a new review; viewer membership does not permit writes.

The server uses MCP TypeScript SDK 1.32.1 and applies a **256-element aggregate
tool-input ceiling before schema validation and handler execution**. Keep
arguments to the tool's declared schema. The ceiling is an abuse budget, not
a substitute for field validation, authorization or the HTTP body limit.

## Test the connection without changing live care

Run `npm run check` from an installed checkout with the pinned Node version.
The focused coverage includes
[`family-release-journey.test.ts`](../test/family-release-journey.test.ts),
[`mcp-standard-auth.test.ts`](../test/mcp-standard-auth.test.ts),
[`auth.test.ts`](../test/auth.test.ts) and
[`membership-http.test.ts`](../test/membership-http.test.ts).

These tests exercise real loopback HTTP and SDK protocol flows with synthetic
upstream identities and storage. They do not prove compatibility with every
third-party client, a live account or a physical device. Use the
[local care story](story-demo.md) to inspect actual local MCP writes and shared
state without cloud credentials or real recipients.

Kin's classic Alexa development skill is a separate Echo integration. Its web
conversation is Kin's own interface, not Amazon's Alexa+ interface. Neither
local protocol tests nor discovery metadata establish native Toolkit access.
