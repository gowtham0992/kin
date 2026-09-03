# Kin

Kin is a shared family-care circle designed for voice-first confirmation on Alexa+ and live coordination across a family.

This repository begins with the portable core: an MCP `2025-11-25`-compatible server using Streamable HTTP and an MCP Apps widget. Amazon onboarding metadata will be added after MCP Toolkit partner access is confirmed.

## Current vertical slice

- `show_today` returns today's care plan as text plus structured widget data.
- `confirm_care_task` records `done`, `not_yet`, or `skipped` responses.
- Confirmation writes require an idempotency key so retries do not duplicate effects.
- A small MCP Apps resource renders the Today view.
- In-memory demo data keeps the first slice runnable without cloud credentials.
- A DynamoDB repository uses strongly consistent reads and an atomic transaction for the task update plus idempotency record.
- Missed-task sweeps persist a deterministic outbox record, acquire a conditional 60-second delivery lease, and record the SNS message identifier or a privacy-safe failure code.
- The caregiver view renders queued, sending, sent, failed, blocked, and empty escalation states from the same shared snapshot.
- `show_weekly_brief` and `/api/weekly-brief` summarize a seven-day activity window with evidence IDs for every observation.
- Bedrock ranks recorded events and selects safe follow-up categories; Kin renders every user-visible sentence directly from stored facts.
- Model output is schema-checked and rejected if it cites an unknown event or applies a follow-up to the wrong event type; failures fall back to a deterministic brief.

## Run locally

```bash
npm install
npm run check
npm start
```

The MCP endpoint is `http://127.0.0.1:3000/mcp`; health is available at `/health`.
The Alexa+-style web simulator is served at `http://127.0.0.1:3000/` and uses the same care-state operation as the MCP tools.

Set `KIN_DYNAMODB_TABLE`, `KIN_CIRCLE_ID`, `KIN_TIME_ZONE`, and `AWS_REGION` to use the AWS-backed repository. `KIN_TIME_ZONE` is an IANA identifier such as `America/Denver` and keeps daily care state aligned with the family's calendar after UTC midnight. With no table configured, Kin intentionally starts in local demo mode.

Seed the cloud demo without overwriting existing confirmations:

```bash
AWS_PROFILE=kin-dev \
AWS_REGION=us-east-1 \
KIN_DYNAMODB_TABLE=kin-care-state \
KIN_CIRCLE_ID=demo-family \
npm run seed:aws
```

Run the missed-task worker with `KIN_ALERT_TOPIC_ARN` set in the local environment:

```bash
AWS_PROFILE=kin-dev \
AWS_REGION=us-east-1 \
KIN_DYNAMODB_TABLE=kin-care-state \
KIN_CIRCLE_ID=demo-family \
KIN_ALERT_TOPIC_ARN="$KIN_ALERT_TOPIC_ARN" \
npm run sweep:aws
```

Kin prevents concurrent workers from publishing the same alert by leasing the outbox record. SNS standard-topic delivery is at least once; an ambiguous provider timeout can still produce a duplicate, so the message is deliberately non-alarming and contains no task details.

Generate the grounded weekly brief with Amazon Nova through the scoped application role:

```bash
AWS_PROFILE=kin-dev \
AWS_REGION=us-east-1 \
KIN_DYNAMODB_TABLE=kin-care-state \
KIN_CIRCLE_ID=demo-family \
KIN_TIME_ZONE=America/Denver \
KIN_BEDROCK_MODEL_ID=amazon.nova-micro-v1:0 \
npm run brief:aws
```

Without `KIN_BEDROCK_MODEL_ID`, the server deliberately uses the evidence-linked deterministic brief. Model errors, incomplete generations, invalid JSON, schema violations, unknown evidence references, and inapplicable follow-up selections take the same safe fallback path.

`npm run infra:synth` produces the reviewable CloudFormation template without deploying it. The table uses on-demand billing, AWS-managed encryption, seven-day point-in-time recovery, deletion protection, and retain-on-delete behavior.

The reasoning and reversal conditions behind these choices live in [docs/architecture.md](docs/architecture.md).
The verified cloud state and restricted deployment workflow live in [docs/aws-deployment.md](docs/aws-deployment.md).

## Product boundary

Kin coordinates ordinary family care. It is not a medical device, medication adviser, fall detector, or emergency monitoring service.
