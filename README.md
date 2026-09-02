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

## Run locally

```bash
npm install
npm run check
npm start
```

The MCP endpoint is `http://127.0.0.1:3000/mcp`; health is available at `/health`.
The Alexa+-style web simulator is served at `http://127.0.0.1:3000/` and uses the same care-state operation as the MCP tools.

Set `KIN_DYNAMODB_TABLE`, `KIN_CIRCLE_ID`, and `AWS_REGION` to use the AWS-backed repository. With no table configured, Kin intentionally starts in local demo mode.

Seed the cloud demo without overwriting existing confirmations:

```bash
AWS_PROFILE=kin-dev \
AWS_REGION=us-east-1 \
KIN_DYNAMODB_TABLE=kin-care-state \
KIN_CIRCLE_ID=demo-family \
npm run seed:aws
```

`npm run infra:synth` produces the reviewable CloudFormation template without deploying it. The table uses on-demand billing, AWS-managed encryption, seven-day point-in-time recovery, deletion protection, and retain-on-delete behavior.

The reasoning and reversal conditions behind these choices live in [docs/architecture.md](docs/architecture.md).
The verified cloud state and restricted deployment workflow live in [docs/aws-deployment.md](docs/aws-deployment.md).

## Product boundary

Kin coordinates ordinary family care. It is not a medical device, medication adviser, fall detector, or emergency monitoring service.
