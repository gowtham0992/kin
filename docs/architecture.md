# Kin architecture decision

Kin will ship as one deployable TypeScript service with a DynamoDB care-state store. This keeps the Alexa+/MCP interaction fast and understandable while giving task confirmations the durability and idempotency a real family coordination product requires.

The AWS deployment region is `us-east-1`. Deployment must use a named, non-root IAM or IAM Identity Center principal; Kin will not be provisioned from the AWS account root identity.

The data stack uses CDK's bootstrapless synthesizer because it contains no file or container assets. This avoids provisioning general-purpose CDK asset roles and keeps the deployer limited to the named Kin stack and execution role.

## The system must preserve trust before adding breadth

The core invariant is simple: one spoken confirmation produces one durable state transition, even when Alexa, the network, or a client retries. A confirmation and its idempotency record therefore commit in the same DynamoDB transaction. Reads are strongly consistent so an Echo Show and a caregiver phone do not contradict each other immediately after a confirmation.

Kin is ordinary family-care coordination, not emergency monitoring or a medical device. The product must never diagnose, recommend medication, imply that someone is safe because a task was completed, or silently discard a missed-task escalation.

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
2. DynamoDB repository and protected table definition — complete locally; cloud deployment awaits account authorization.
3. Rotating caregiver duty and a durable missed-task outbox.
4. SMS delivery with retry evidence and a simulator-visible escalation timeline.
5. Bedrock weekly care brief grounded only in recorded family events.
6. OAuth 2.1/PKCE, deployment hardening, telemetry, and a recorded Alexa+ demo.

Each slice must keep `npm run check` green and expose one end-to-end behavior a judge can see. AWS deployment, phone-number messaging, and public repository publication require explicit owner approval because they change external state or can incur cost.
