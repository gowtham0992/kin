# Kin architecture decision

Kin will ship as one deployable TypeScript service with a DynamoDB care-state store. This keeps the Alexa+/MCP interaction fast and understandable while giving task confirmations the durability and idempotency a real family coordination product requires.

The AWS deployment region is `us-east-1`. Deployment must use a named, non-root IAM or IAM Identity Center principal; Kin will not be provisioned from the AWS account root identity.

The data stack uses CDK's bootstrapless synthesizer because it contains no file or container assets. This avoids provisioning general-purpose CDK asset roles and keeps the deployer limited to the named Kin stack and execution role.

## The system must preserve trust before adding breadth

The core invariant is simple: one spoken confirmation produces one durable state transition, even when Alexa, the network, or a client retries. A confirmation and its idempotency record therefore commit in the same DynamoDB transaction. Reads are strongly consistent so an Echo Show and a caregiver phone do not contradict each other immediately after a confirmation.

Kin is ordinary family-care coordination, not emergency monitoring or a medical device. The product must never diagnose, recommend medication, imply that someone is safe because a task was completed, or silently discard a missed-task escalation.

Daily and weekly windows are evaluated in the care circle's configured IANA timezone rather than the server's UTC date. This prevents an evening family interaction from silently moving to tomorrow's plan after UTC midnight.

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
3. Rotating caregiver duty and a durable missed-task outbox — complete, including conditional delivery leases.
4. SNS delivery with retry evidence and a simulator-visible escalation timeline — complete; filtered SMS subscriptions await caregiver consent and a destination number.
5. Bedrock-assisted weekly family brief grounded only in recorded events — complete, with bounded DynamoDB reads, constrained event selection, schema and applicability validation, token metadata, and deterministic fallback.
6. OAuth 2.1/PKCE, deployment hardening, telemetry, and a recorded Alexa+ demo.

Each slice must keep `npm run check` green and expose one end-to-end behavior a judge can see. AWS deployment, phone-number messaging, and public repository publication require explicit owner approval because they change external state or can incur cost.

SNS standard topics provide at-least-once delivery. The outbox prevents concurrent workers and successful replays from publishing twice, but a network failure after SNS accepts a message and before Kin receives the message identifier remains an ambiguity window. Kin stores only a provider error code, never raw provider text, and uses privacy-minimized alert copy so a rare duplicate is understandable rather than alarming.

The public Today snapshot is an explicit projection, not a serialized database record. It exposes the task, status, recipient display name, and event time required by the family UI; it excludes provider message identifiers, attempt identifiers, delivery leases, attempt counts, and internal failure codes.

The weekly brief follows the same trust boundary. Bedrock receives a bounded seven-day projection containing task status and privacy-minimized escalation facts, not raw database records or caregiver confirmation identities. The model cannot author prose: it ranks supplied evidence IDs and chooses from two follow-up categories. Kin renders the headline, overview, observations, and follow-ups directly from stored facts. Output that is incomplete, malformed, outside the schema, references unknown evidence, or applies a follow-up to the wrong event type is discarded; Kin returns a deterministic brief from the same source facts instead. The brief is coordination context only and always carries a non-medical safety notice.
