# Kin architecture decision

Kin will ship as one deployable TypeScript service with a DynamoDB care-state store. This keeps the Alexa+/MCP interaction fast and understandable while giving task confirmations the durability and idempotency a real family coordination product requires.

The AWS deployment region is `us-east-1`. Deployment must use a named, non-root IAM or IAM Identity Center principal; Kin will not be provisioned from the AWS account root identity.

The first data-only deployment used CDK's bootstrapless synthesizer. The scheduled escalation worker is now a bundled Lambda asset, so subsequent deployments use the standard CDK asset contract. Bootstrap and execution permissions remain separate from application permissions; `kin-dev` cannot deploy infrastructure and the Lambda role can access only the named table, topic, dead-letter queue, logs, and X-Ray APIs it needs.

## The system must preserve trust before adding breadth

The core invariant is simple: one spoken confirmation produces one durable state transition, even when Alexa, the network, or a client retries. A confirmation and its idempotency record therefore commit in the same DynamoDB transaction. Reads are strongly consistent so an Echo Show and a caregiver phone do not contradict each other immediately after a confirmation.

Kin is ordinary family-care coordination, not emergency monitoring or a medical device. The product must never diagnose, recommend medication, imply that someone is safe because a task was completed, or silently discard a missed-task escalation.

Daily and weekly windows are evaluated in the care circle's configured IANA timezone rather than the server's UTC date. Because existing sort keys contain UTC timestamps, DynamoDB reads use a bounded one-day buffer on each side and filter results against the IANA timezone in the repository. This keeps the deployed data compatible while preventing a late-evening task from silently moving to tomorrow's plan. If a circle grows beyond hundreds of tasks per week, add an explicit local-care-date access pattern rather than widening these reads.

## One aggregate fits the access pattern

All data for a family care circle shares `PK = CIRCLE#<circleId>`. Sort keys make the common operations direct:

- `TASK#<ISO due time>#<taskId>` stores a scheduled care task.
- `CONFIRMATION#<requestId>` stores the immutable idempotency record.
- Later slices add duty assignments and escalation outbox events under the same aggregate.

DynamoDB wins here because Kin's important operations are key-based, the aggregate is small, and an on-demand serverless table matches a bursty demo workload. We will reverse this choice if the product requires cross-circle reporting, flexible ad-hoc querying, or multi-aggregate transactions; those needs would favor a relational store.

## Boundaries keep the demo honest

`CareRepository` is the application boundary. The in-memory implementation powers a zero-credential local demo, while `DynamoCareRepository` uses the same contract in AWS. HTTP, the Alexa+-style simulator, and MCP tools all call that boundary; none has a private mock state path.

The current AWS transaction writes the updated task and `CONFIRMATION#<requestId>` together. Its condition expression prevents a retry from producing a second effect. A retry reads and returns the original confirmation.

## Delivery grows in verifiable slices

1. Shared care plan and idempotent voice confirmation — complete and contract-tested.
2. DynamoDB repository and protected table definition — complete and verified in `us-east-1`.
3. Seven-day sibling rotation roster and durable missed-task outbox — complete, including an editable Circle view, DynamoDB-persisted handoffs, DST-safe local-day boundaries, and conditional delivery leases.
4. SNS delivery with retry evidence and a simulator-visible escalation timeline — complete; filtered SMS subscriptions await caregiver consent and a destination number.
5. Bedrock-assisted weekly family brief grounded only in recorded events — complete, with bounded DynamoDB reads, constrained event selection, schema and applicability validation, token metadata, and deterministic fallback.
6. Five-minute scheduled escalation worker — deployed and live, including strict scheduler input, immutable outbox recipient routing, local-midnight coverage, least-privilege IAM, retry destinations, DLQ, alarms, structured logs, and X-Ray.
7. Consent-based filtered SMS subscriptions and authenticated roster administration.
8. OAuth 2.1/PKCE, deployment hardening, telemetry, and a recorded Alexa+ demo.

OAuth authorization state is isolated from family care records in the
`kin-oauth-state` table. The authorization server uses the maintained
`oidc-provider` protocol implementation rather than custom token or PKCE logic.
Its DynamoDB adapter atomically stores authorization artifacts with TTL, treats
expired records as absent before asynchronous TTL cleanup, records one-time code
consumption, and maintains grant, session-UID, and user-code indexes needed for
revocation and replay resistance. The table is encrypted, deletion-protected,
retained, and configured for seven-day point-in-time recovery. Signing keys,
cookie keys, and client secrets will remain outside the table and deployment
artifact in Secrets Manager.

Family passwords belong to a separate, retained Cognito user pool, not Kin's
tables. Public self-registration is disabled for the hackathon deployment;
accounts are deliberately invited by the owner. The pool requires 12-character
mixed passwords, suppresses user-existence errors, verifies email, and exposes a
secretless internal app client only for the server-side password flow. The Kin
authenticator bounds credential sizes, converts expected account failures to one
generic result, reads Cognito's stable `sub` after authentication, and refuses
unimplemented challenge flows. MFA remains off until the interaction UI supports
the full challenge ceremony; enabling it earlier would strand account linking
mid-flow rather than improve it.

The account-linking interaction is rendered server-side without JavaScript or
third-party assets. A short-lived provider interaction cookie and an HMAC bound
to the interaction identifier protect form submissions; the page is non-cacheable
and carries a restrictive Content Security Policy. Consent code accepts only
Kin's exact MCP resource URI and the two user-level Alexa scopes. Any foreign
resource, elevated scope, stale step, mismatched interaction, or forged form
token fails closed before a grant is written.

Each slice must keep `npm run check` green and expose one end-to-end behavior a judge can see. AWS deployment, phone-number messaging, and public repository publication require explicit owner approval because they change external state or can incur cost.

SNS standard topics provide at-least-once delivery. The outbox prevents concurrent workers and successful replays from publishing twice, but a network failure after SNS accepts a message and before Kin receives the message identifier remains an ambiguity window. Kin stores only a provider error code, never raw provider text, and uses privacy-minimized alert copy so a rare duplicate is understandable rather than alarming.

The outbox record freezes the recipient at the moment the escalation is created. A failed delivery retry publishes from that record, never from the current roster, so a duty handoff cannot silently redirect an old alert while its audit trail still names the original caregiver.

The public Today snapshot is an explicit projection, not a serialized database record. It exposes the task, status, recipient display name, and event time required by the family UI; it excludes provider message identifiers, attempt identifiers, delivery leases, attempt counts, and internal failure codes.

The weekly brief follows the same trust boundary. Bedrock receives a bounded seven-day projection containing task status and privacy-minimized escalation facts, not raw database records or caregiver confirmation identities. The model cannot author prose: it ranks supplied evidence IDs and chooses from two follow-up categories. Kin renders the headline, overview, observations, and follow-ups directly from stored facts. Output that is incomplete, malformed, outside the schema, references unknown evidence, or applies a follow-up to the wrong event type is discarded; Kin returns a deterministic brief from the same source facts instead. The brief is coordination context only and always carries a non-medical safety notice.
