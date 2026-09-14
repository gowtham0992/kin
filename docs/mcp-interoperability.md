# Standard MCP clients can sign in to Kin

Kin now passes a local, SDK-driven OAuth journey from an unauthenticated MCP
connection through family consent to a reviewed care write. This removes a
client-compatibility blocker without requiring Alexa Toolkit access. It is not
proof of live deployment or official Alexa integration.

Deployment update: the September 8 controlled release now serves standard MCP
discovery on public HTTPS, with verified OAuth metadata and public-only JWKS.
The authenticated external-client journey remains unverified; these GET smoke
checks do not replace token exchange or real MCP tool use. See
[release evidence](release-attempt-20260908.md).

## Select standard mode for ordinary OAuth clients

`KIN_MCP_AUTH_MODE=standard` opts the authenticated runtime into user-oriented
OAuth discovery. Leaving it unset selects the existing `alexa` profile. Invalid
or blank values fail configuration validation.

Standard mode requires the existing OAuth configuration: a canonical HTTPS MCP
resource, issuer, JWKS URI, and authorization-server URL (which defaults to the
issuer). The resource comes from either `KIN_MCP_CANONICAL_URI` or
`KIN_MCP_RESOURCE_PARAMETER`, never both. It also needs a current family
membership to serve a user; OAuth alone does not grant family access. The
configured runtime obtains membership from its care table.

The flag changes discovery, not client registration. A connecting client still
needs its own preregistered client record and exact approved callback URI. This
pass adds neither dynamic registration nor arbitrary callback support. The test
client uses Kin's existing public browser-client configuration; it is not a
recipe for reusing that client ID in unrelated applications. Never put service
credentials into a browser or the local story.

Standard mode serves protected-resource metadata on both
`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`. It advertises only `mcp:tools` and
`mcp:resources`. Token failures include a `WWW-Authenticate` challenge pointing
to the configured metadata URL. Insufficient-scope responses name the relevant
operation scope. Missing or revoked membership instead returns
`403 family_access_denied` with no scope-upgrade challenge.

The default Alexa profile retains its three advertised scopes and no-challenge
behavior. Authorization-server metadata still describes the separate service
grant. A single deployed endpoint selects one profile; this change does not
negotiate a different profile for each caller.

## User initialization no longer asks for service authority

Previously, user grants contained `mcp:tools mcp:resources`, but MCP initialization
required `mcp:service`. The SDK therefore failed before it could call a tool.
Automatic discovery also selected the service scope from metadata, which the
user consent flow correctly refused.

Only `initialize`, `notifications/initialized`, `ping`, and `tools/list` now
accept any recognized MCP scope after token verification. These operations
expose protocol and static tool metadata, not care state. User-scoped requests
recheck active membership in the configured circle, including metadata requests.
Adding `mcp:service` to a user token does not bypass that check.

| Verified token scope | Protocol/tool metadata | Care-tool calls | Widget resources |
| --- | --- | --- | --- |
| `mcp:service` only | Allowed without membership | Denied | Denied |
| `mcp:tools` only | Active membership required | Membership and role required | Denied |
| `mcp:resources` only | Active membership required | Denied | Active membership required |
| Both user scopes | Active membership required | Membership and role required | Active membership required |

Signature, issuer, audience, expiry and subject checks remain in force. Unknown
scopes do not grant initialization. Malformed or batched requests do not gain
the metadata exemption. Review freshness, authenticated actor attribution and
idempotent confirmation handling are unchanged.

## Reproduce the local evidence

From the Kin project directory, with dependencies installed:

```bash
npm run build
npm test -- --sequence.shuffle --sequence.seed=20260908
npm test -- --sequence.shuffle --sequence.seed=73091
```

Verification at the MCP milestone: the build passed and both shuffled runs passed all
705 tests across 59 files. The suite still reports bundle-size and generated
source-map warnings; these results are not deployment or latency evidence.

The implementation uses the installed MCP TypeScript SDK `1.30.0`. The focused
evidence lives in `test/family-release-journey.test.ts`,
`test/mcp-standard-auth.test.ts`, `test/auth.test.ts`,
`test/membership-http.test.ts` and `test/runtime.test.ts`.

The SDK journey covers discovery, PKCE S256, explicit login and consent,
provider-issued resource-bound JWTs, initialization, ping, tool discovery, care
reads, reviewed saves, safe retries and widget retrieval. Negative cases cover
wrong verifiers, declined consent, revoked and foreign-circle memberships,
viewer writes, service-only data access and both narrow user grants. Selected
guards were deliberately weakened in isolated copies to confirm the regression
tests fail; the working source was not weakened.

The bearer-token SDK journeys use actual loopback HTTP sockets. Automatic OAuth
uses an exact-allowlisted HTTPS-to-local-HTTP bridge to Kin's real application
and authorization-provider routes. Upstream account authentication and storage
are synthetic; there is no DNS/TLS, real browser UI, Cognito, DynamoDB, model
invocation or message delivery in these journeys. Passing them does not prove
compatibility with every desktop or hosted MCP client.

## Deployment and voice evidence remain separate

This pass makes no cloud, IAM, account, callback or live configuration changes.
The fresh candidate and current verification are recorded in
[release readiness](release-readiness.md). A controlled release still needs an
explicit profile choice and worker-pause checks. Those gates were completed in
the subsequent controlled release linked above; the earlier candidate in the
historical handoff must not be promoted.

The local story remains clearly labeled as simulated. Optional natural-language
interpretation and browser dictation are now implemented and tested with
synthetic providers; see the [story guide](story-demo.md). Real speech-provider
behavior, a third-party MCP client on deployed HTTPS, and official Alexa/Echo
behavior are separate evidence. None is established by these OAuth tests.
