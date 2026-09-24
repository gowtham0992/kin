# Kin

Kin helps a family share everyday check-ins, follow-ups, and the next turn at care.

The family workspace includes shared check-ins, care plans, duty handoffs,
follow-up acknowledgment, invitations, access management and evidence-linked
weekly notes. Its portable core is an MCP `2025-11-25`-compatible server using
Streamable HTTP and an MCP Apps widget. The Alexa+ interface is a labeled
simulation over real MCP calls. A separate classic Alexa development skill
connects the owner's Echo Pop to the same linked family account; it is not a
native Alexa+ add-on.

For the hackathon, Kin targets the self-hosted MCP route with AWS Builder.
The MCP protocol baseline is deliberately **2025-11-25**, the track's minimum,
not a claim that Kin uses the newest protocol or has native Alexa+ toolkit access.
Skills Store publication is not required for this development-skill demonstration.

Standard MCP clients complete
the tested OAuth sign-in, consent, discovery and reviewed-save journey without
service credentials. See [MCP interoperability](docs/mcp-interoperability.md)
for configuration and the limits of that local evidence.

### What is real, and what remains to verify

This is a dated checkpoint, not a live health guarantee. Source changes are not
automatically deployed, and an isolated test is not recurring-service acceptance.

| Capability | Evidence and boundary |
| --- | --- |
| Family workspace and classic Echo connection | Deployed; owner has used linked plan reads on an Echo Pop and a second caregiver has joined the shared workspace. |
| Alexa reminder creation and cancellation | Owner reported a reminder appearing and later disappearing. Automatic reconciliation is now enabled; see the [activation and recovery evidence](docs/reminder-activation-20260918.md). |
| Missed-check-in phone notification | September 23 bounded recurring acceptance passed: two real scheduled sweeps, one delivery attempt, owner-confirmed receipt, and stored acknowledgment without completing the check-in. Worker and schedule were restored off. See [acceptance evidence](docs/recurring-acceptance-20260923.md). |
| Operational alerts | Operator email routing has been tested; these are separate from family notifications. |
| Alexa+ conversation | Clearly labeled simulation using real MCP calls—not native toolkit access. |
| Close without a reply | Synthetic closure, attribution and reload passed September 20; corrected weekly totals were deployed and read back by the caregiver September 22 and organizer September 23. See [current status](STATUS.md). |
| Release candidate | A matching committed, tagged, fresh-clone release is still outstanding. Historical clone checks do not prove the current working tree reproduces production. |

The repository remains private. Reviewers need separately authorized repository
access and a dedicated Kin account/invitation; do not share owner credentials.
The local story below needs neither AWS credentials nor a family account.
See the [acceptance runbook](docs/final-acceptance-runbook.md) for device checks.
Start an independent review with the [reviewer guide](docs/reviewer-guide.md).

## Try one complete family-care story

Use Node **22.23.2** (pinned in `.nvmrc`), install the locked dependencies,
and start the isolated demonstration:

```bash
npm ci
npm run demo:story
```

Open `http://127.0.0.1:3030/story.html`. Evelyn's morning check-in and Theo's
family view share one in-memory store: the parent uses real Streamable HTTP MCP,
while the caregiver reads the REST API independently.

1. Choose **Not yet**, then **Review request** and **Confirm this check-in**.
   The example button only fills the draft; reviewing does not save it.
2. Advance the demo clock to **9:31 AM**. The real escalation sweep records a
   simulated notification for Theo after the 30-minute grace period.
3. Acknowledge the follow-up in Theo's view. Evelyn's task remains incomplete.
4. Draft **Done**, review it and confirm. Read the weekly brief to inspect the
   recorded activity and source evidence.

The clock starts at 9 AM on September 8, 2026 in Denver; six earlier days contain
synthetic completed check-ins. Alexa dialogue, people, time and notifications
are simulated. By default, this command does not configure a cloud repository,
use AWS credentials, invoke a model or send messages. Optional browser dictation
starts only when requested, may send audio to the browser's speech provider,
and only fills a draft. Typing always remains available.

An explicit `--bedrock` launch option makes Amazon Nova available with a named
AWS profile. Every model request needs its own checkbox consent, may incur
charges, and can only propose a reviewed action. The process caps model attempts
at 20 and bounds the caller's wait to five seconds. See the
[story guide](docs/story-demo.md) for setup, privacy and timeout behavior.
The server binds to loopback and rejects foreign browser origins. Do not expose
it through a tunnel or proxy.

Restart the command for a fresh story. Reloading preserves the running server's
synthetic care state but clears draft, transcript, trace and pending-retry memory.
The evidence panel shows actual client-observed MCP IDs and validated results,
not device latency or proof of delivery. The story page refuses to operate when
its dedicated local endpoint is unavailable; these controls are not part of the
authenticated family deployment.

Simple first-person replies such as “I already had my water” can propose a
check-in without a paid model. Kin asks you to choose when the task is unclear
or several titles match. Interpretation never saves a reply by itself.

For reproducible verification, run `npm run check`. Browser checks use the
locked Playwright dependency: install its browser with
`npx --no-install playwright install chromium`, then run `npm run test:browser`.
The checked-in GitHub workflow builds, runs two shuffled test passes and checks
the synthetic story in Chromium. It does not deploy or use AWS credentials.

## Current vertical slice

- In standard MCP mode, signed-in Ask Kin reads and saves through authenticated
  MCP, with a bounded request trace. Task interpretation only proposes a change;
  an explicit confirmation performs the MCP write. No official Alexa device
  connection is implied.
- `show_today` returns today's care plan as text plus structured widget data.
- `confirm_care_task` records `done`, `not_yet`, or `skipped` responses.
- Confirmation writes require an idempotency key so retries do not duplicate effects.
  MCP and authenticated HTTP clients must also supply the reviewed task snapshot
  returned by `show_today`; missing or changed reviews cannot save a new reply.
- A small MCP Apps resource renders the Today view.
- In-memory demo data keeps the first slice runnable without cloud credentials.
- A DynamoDB repository uses strongly consistent reads and an atomic transaction for the task update plus idempotency record.
- Missed-task sweeps persist a deterministic outbox record, acquire a conditional 60-second delivery lease, and record the SNS message identifier or a privacy-safe failure code.
- When explicitly enabled, the deployable worker runs that sweep every five minutes through EventBridge Scheduler, with bounded retries, a retained encrypted dead-letter queue, alarms, structured logs, and X-Ray tracing. New worker and schedule controls default to paused; see [release controls](docs/release-controls.md) before deployment.
- Retries publish to the caregiver frozen into the durable outbox record even if the duty assignment changes later.
- The Circle view makes the seven-day Maya/Theo rotation visible and editable, persists handoffs in DynamoDB, and derives exact local-day boundaries across daylight-saving changes.
- **Propose next week** fills uncovered days using recent assigned responsibility,
  preserves commitments, and saves the reviewed week atomically. A changed
  roster invalidates the review; uncertain retries reuse the same receipt.
- The caregiver view renders queued, sending, sent, failed, blocked, receipt-pending,
  and empty escalation states from the same shared snapshot.
- `show_weekly_brief` and `/api/weekly-brief` summarize a seven-day activity window with evidence IDs for every observation.
- Bedrock ranks recorded events and selects safe follow-up categories; Kin renders every user-visible sentence directly from stored facts.
- Model output is schema-checked and rejected if it cites an unknown event or applies a follow-up to the wrong event type; failures fall back to a deterministic brief.
- The Alexa OAuth foundation uses `oidc-provider` for protocol and cryptographic
  behavior, issues only resource-bound one-hour service tokens, and rejects
  service credentials that request user permissions.
- Authorization codes, sessions, refresh tokens, replay consumption, and grant
  revocation use an encrypted, TTL-backed DynamoDB adapter rather than Lambda
  memory.
- A retained Cognito user pool owns family credentials and stable account IDs;
  Kin receives only the login form submission and never stores a password.
- Alexa account linking has a first-party, accessible Kin interaction flow with
  explicit consent, CSRF protection, strict browser headers, and a safe cancel
  path back to the OAuth client.
- The AWS stack hosts that standards server on the same `execute-api` origin,
  generates all private OAuth material inside retained Secrets Manager storage,
  and keeps the heavier authorization runtime out of the latency-critical MCP
  Lambda.

## Run locally

```bash
npm install
npm run check
npm start
```

The MCP endpoint is `http://127.0.0.1:3000/mcp`; health is available at `/health`.
The Alexa+-style web simulator is served at `http://127.0.0.1:3000/` and uses the same care-state operation as the MCP tools.
Its Circle tab reads and updates the duty assignments used by the escalation worker without exposing phone numbers or delivery internals.

Local development intentionally runs without OAuth. To expose Kin as an Alexa+
MCP server outside the supplied AWS stack, configure these production variables
together:

```text
KIN_MCP_CANONICAL_URI=https://api.example.com/mcp
KIN_OAUTH_ISSUER=https://auth.example.com/
KIN_OAUTH_JWKS_URI=https://auth.example.com/.well-known/jwks.json
```

The AWS stack instead writes its generated API Gateway `execute-api` MCP URL to
SSM Parameter Store and supplies `KIN_MCP_RESOURCE_PARAMETER`; the Lambda reads
and caches that exact URL for metadata and token-audience validation. No custom
domain or certificate is required.

`KIN_OAUTH_AUTHORIZATION_SERVER` can override the issuer URL advertised in
protected-resource metadata. When OAuth is configured, Kin validates JWT
signatures, issuer, audience/resource binding, expiration, and Alexa's reserved
scopes. The local family simulator is not served unless
`KIN_SERVE_SIMULATOR=true` is explicitly set.

For ordinary MCP OAuth clients, opt into `KIN_MCP_AUTH_MODE=standard` alongside
the existing OAuth and membership configuration. This enables user-scope
discovery challenges; it does not register new clients or callbacks. The
default `alexa` mode preserves the existing Alexa discovery profile. See the
[interoperability guide](docs/mcp-interoperability.md) before selecting a mode.

Set `KIN_DYNAMODB_TABLE`, `KIN_CIRCLE_ID`, `KIN_TIME_ZONE`, and `AWS_REGION` to use the AWS-backed repository. `KIN_TIME_ZONE` is an IANA identifier such as `America/Denver` and keeps daily care state aligned with the family's calendar after UTC midnight. With no table configured, Kin intentionally starts in local demo mode.

Initialize a cloud demo without overwriting existing records. This command is
initialization-only: once the circle has a plan-control record (from initialization
or task activity), it refuses further seeding. It reads the complete bounded seed
set, then atomically inserts only missing rows and the initial plan version. A
concurrent pause or task write prevents the transaction; nothing is partially
seeded. Use the reviewed family workspace for subsequent plan changes. This
requires separately authorized DynamoDB read/transaction permissions and makes
real cloud writes; do not use it as a live notification test.

```bash
AWS_PROFILE=kin-dev \
AWS_REGION=us-east-1 \
KIN_DYNAMODB_TABLE=kin-care-state \
KIN_CIRCLE_ID=demo-family \
npm run seed:aws
```

Run the missed-task worker with `KIN_ALERT_TOPIC_ARN` set in the local environment:

This is a manual, full-circle sweep that bypasses the deployed worker pause.
Do not use it for a one-message acceptance test or before destination consent
and routing have been verified.

```bash
AWS_PROFILE=kin-dev \
AWS_REGION=us-east-1 \
KIN_DYNAMODB_TABLE=kin-care-state \
KIN_CIRCLE_ID=demo-family \
KIN_TIME_ZONE=America/Denver \
KIN_ALERT_TOPIC_ARN="$KIN_ALERT_TOPIC_ARN" \
npm run sweep:aws
```

Kin uses a delivery lease to limit competing workers; it does not guarantee
exactly-once notification delivery. Known provider acceptance followed by a
receipt-write error is held for reconciliation, not automatically resent.
Expired sending attempts are also held because a stopped process may already
have published. Provider timeouts remain ambiguous and can duplicate on retry.
Messages contain no task details and ask the caregiver to check Kin.
See [delivery operations](docs/delivery-operations.md) for the deployed hardening,
alarm destination setup, and the live verification still required before activation.

A recorded `not_yet` reply keeps the task incomplete and starts the configured
grace period from the later of its due time or latest reply time (30 minutes by
default). Replaying the same confirmation keeps the original timestamp.
Subsequent sweeps use this timing; it does not cancel queued, in-flight or sent
notifications. The worker evaluates tasks due today or yesterday in the circle's
time zone; it is not an indefinite follow-up scheduler.

Today includes unresolved follow-ups from the previous local day alongside
today's alerts. Acknowledging yesterday's follow-up removes it from this view,
without completing the task or cancelling delivery. Older alerts remain
addressable by their stable IDs but have no historical inbox in this slice.

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
In the current source, MCP's weekly model budget remains 300 ms by default
(`KIN_BEDROCK_TIMEOUT_MS`). Authenticated REST Week uses a separate 5,000 ms
budget, configurable with `KIN_WORKSPACE_BEDROCK_TIMEOUT_MS` as a decimal integer
from 50 to 5000. Browser Ask Kin still uses MCP's shorter budget. These bound
model waiting, not the entire request; authentication and database reads also
take time. Weekly model calls make one SDK attempt and abort at their deadline,
then return the evidence-linked fallback if generation fails.

The offline `brief:aws` command also honors `KIN_BEDROCK_TIMEOUT_MS` (integer
50–10000 ms; default 300). It reads the configured real family table and can
incur model charges; do not use it as a synthetic diagnostic. The browser
budget is deployed; see the [release evidence](docs/finish-api-release-20260916.md)
and [subsequent weekly validation](docs/weekly-contract-20260918.md).

`npm run infra:synth` bundles the Lambda and produces a reviewable CloudFormation template without deploying it. The table uses on-demand billing, AWS-managed encryption, seven-day point-in-time recovery, deletion protection, and retain-on-delete behavior. Lambda assets require a standard CDK bootstrap before deployment; the exact current account status is documented in `docs/aws-deployment.md`.

The reasoning and reversal conditions behind these choices live in [docs/architecture.md](docs/architecture.md).
The verified cloud state and restricted deployment workflow live in [docs/aws-deployment.md](docs/aws-deployment.md).
The Alexa access gate and integration contract live in [docs/alexa-readiness.md](docs/alexa-readiness.md).

## Product boundary

Kin coordinates ordinary family care. It is not a medical device, medication adviser, fall detector, or emergency monitoring service.

## License

The source is [MIT licensed](LICENSE). Repository visibility remains private at
the owner’s request; adding a license does not publish the repository.
