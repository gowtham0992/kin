# Kin architecture

Kin connects a parent's recorded reply to a shared family plan. Its MCP tools
and family HTTP API use the same care repository; background workers operate
on the same persisted care state rather than separate copies of the plan.

## Connected surfaces share one care model

| Surface | Application boundary |
| --- | --- |
| Family web workspace | Authenticated HTTP reads and reviewed care operations. |
| Web conversation | Interpretation proposes a draft; explicit confirmation calls MCP. |
| Classic Alexa development skill | The linked account authorizes the Echo backend's MCP calls. |
| Standard MCP client | Resource-bound OAuth scopes and active family membership authorize tools and widget resources. |
| Local care story | Real loopback MCP and HTTP with one isolated in-memory repository and synthetic activity. |

The web conversation is Kin's own interface, not Amazon's Alexa+ interface.
The classic Echo connection is distinct from native Alexa+ Toolkit access.
Linked-account attribution identifies an authorized account, not the person
physically speaking near a shared device.

[`CareRepository`](../src/domain.ts) defines the care-state boundary. The
in-memory implementation supports local development and the isolated story;
[`DynamoCareRepository`](../src/dynamo-care-repository.ts) persists the same
domain operations in AWS. A runtime is configured for one family circle;
creating another account does not create an isolated family.

## Review and retry are part of a care write

A confirmation carries the selected check-in, requested response, request ID
and exact task snapshot that was reviewed. The server checks current access
and rejects a stale review instead of overwriting a newer task state.

In DynamoDB, the task change and idempotency receipt commit atomically. Retry
an uncertain result with the identical request ID and payload; the original
receipt resolves a successful retry without recording the reply twice.
Authenticated request IDs are namespaced by member, and attribution comes
from server-owned membership rather than a submitted display name.

Feature-gated operations such as completion undo, rescheduling and future-plan
cancellation have separate review and conflict contracts. They are not generic
rollback commands. A caregiver's follow-up acknowledgment is also a separate
record: it means seen, not contacted, completed or safe.

## Authentication and membership are separate gates

API Gateway fronts separate application and OAuth Lambda functions. The OAuth
provider handles authorization-code grants, PKCE, consent and token issuance;
Kin validates signatures, issuer, audience/resource, expiration and recognized
scopes before serving protected operations.

Family credentials belong to Cognito. OAuth artifacts live in a separate
DynamoDB table; private signing material, cookie keys and client secrets stay
in Secrets Manager rather than source, browser assets or care records. Browser sessions
use a separate authenticated workspace flow. The deployment configuration
keeps public-site aliases distinct from canonical workspace and OAuth URLs.

Active membership is checked against the configured circle and requested
permission. The directory uses the verified issuer and subject, not an email
or caller-supplied role. Roster entries do not grant access. Revocation blocks
subsequent requests but cannot retract an operation already in flight.

See [MCP interoperability](mcp-interoperability.md) for discovery profiles,
scope boundaries and client registration requirements.

## Persistent state follows the family's calendar

Care records share a circle partition, with distinct sort keys for tasks,
confirmation receipts, duty assignments, membership and follow-up state.
Strongly consistent reads support immediate readback after a confirmed write.
Daily and weekly windows use the circle's configured IANA time zone, including
daylight-saving transitions, rather than the server's UTC calendar date.

Reads are bounded. The workspace distinguishes an incomplete or failed history
read from a genuinely empty plan. Larger histories need an indexed or paginated
access pattern rather than an ever-wider unbounded query.

## Follow-ups and reminders have independent delivery lifecycles

When explicitly enabled, the scheduled escalation worker evaluates eligible
unanswered check-ins after the normal grace period and writes a durable outbox
record. That record retains its intended caregiver even if duty changes later.
Conditional leases limit competing senders; they do not guarantee exactly-once
delivery. Ambiguous provider outcomes require reconciliation, not blind retries.

Phone enrollment, active membership, duty coverage and worker/scheduler
configuration are separate prerequisites. Configuration state is not proof
of worker health or handset receipt. A push notification contains discreet
follow-up wording rather than care details, and delivery is best-effort.

Echo reminders require their own consent and Alexa permission. Reminder
creation, a recorded check-in reply and caregiver acknowledgment are different
operations. A separately gated reconciliation worker requests cancellation
of Kin-created reminders that no longer apply; cancellation may be delayed or
fail. Users can manage reminders in the Alexa app.

The deployment definitions in [`infra/`](../infra/) keep application code,
permissions, schedules and worker enablement explicit. Enabling a schedule or
running a manual cloud sweep can affect real recipients; neither is a UI-test
or local-story reset procedure.

## Weekly notes stay tied to recorded facts

The weekly brief consumes a bounded activity projection. When configured,
Amazon Bedrock selects allowed evidence IDs and observation categories; Kin
validates the selection and renders text from the corresponding stored facts.
Invalid, missing or unavailable model output uses an evidence-linked
deterministic fallback. A model suggestion cannot silently save a care reply.

Kin coordinates ordinary family care. It does not diagnose, recommend
treatment, detect emergencies or establish that somebody is safe. See the
[privacy and safety guide](../docs-site/content/privacy-and-safety.md) and
[developer guide](development.md) for configuration and verification.
