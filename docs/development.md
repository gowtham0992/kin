# Develop Kin

Run the isolated story to understand the product, then use the local server and
verification commands below. Cloud operations are a separate, explicitly
authorized workflow; none is required for local development.

## Start with the care loop

Use **Node 22.23.2**, pinned in the repository's `.nvmrc`, from the repository
root. With no cloud/runtime variables configured:

```sh
npm ci --ignore-scripts --no-audit --fund=false
npm run demo:story
```

Open <http://127.0.0.1:3030/story.html>. The command builds its browser assets
before starting. Parent and caregiver views share in-memory state; the parent
uses real Streamable HTTP MCP while the caregiver independently reads HTTP.
People, calendar time, Alexa dialogue and notifications are synthetic. The
default launch makes no AWS model or notification calls.

Follow [testing instructions](testing-instructions.md) for the complete
not-yet, follow-up, acknowledgment and completion journey. Restart the process
to reset synthetic data. Reloading preserves server state but clears draft,
transcript, trace and pending-retry memory. Keep this loopback-only service off
public tunnels and proxies.

Optional dictation may send audio to the browser's speech provider and only
fills a draft. Optional `--bedrock` mode requires an explicit named profile and
per-request consent, caps model attempts at 20 per process and may incur charges.
Neither mode saves a proposed response without review. See the
[story guide](story-demo.md) before enabling either.

## Run the application server

```sh
npm run check
npm start
```

With no care table or OAuth configuration, this starts an in-memory development
server bound to `127.0.0.1`, at <http://127.0.0.1:3000/>. The MCP endpoint is
`POST /mcp`; health is `GET /health`. `PORT` changes the port. This developer
interface is Kin's own browser surface, not Amazon's Alexa+ interface.

The public Lambda runtime requires OAuth configuration. The unauthenticated
local mode is not a production deployment recipe, and the isolated story is
intentionally absent from production.

## Verify changes

```sh
npm run check
npx --no-install playwright install chromium
npm run test:browser
npm run test:browser:today
```

`check` builds the application and runs the unit/integration suite. Browser
checks exercise synthetic local journeys, responsive layouts, safe review and
retry behavior. They do not establish physical-device acceptance, real account
onboarding or notification receipt. The GitHub verification workflow runs
locked installation, build, two shuffled suites, real DynamoDB Local transaction
checks and Chromium journeys; it does not deploy or use AWS credentials.
Check the verification run for the exact commit rather than interpreting a
workflow file as a passing result. `npm run test:dynamo -- /path/to/dynamodb-local`
runs the independent database-expression gate against an installed DynamoDB
Local distribution; the CI workflow downloads and checksum-verifies it.

## Configure an authenticated MCP deployment

Kin implements the MCP `2025-11-25` baseline over Streamable HTTP, with an MCP
Apps Today resource. Its main tools read Today, record a reviewed response and
produce an evidence-linked weekly brief. Feature-gated tools also support
reviewed cancellation, completion undo and reminder consent tickets.

For a deployment outside the supplied AWS stack, configure the canonical MCP
resource and OAuth endpoints together:

```text
KIN_MCP_CANONICAL_URI=https://api.example.com/mcp
KIN_OAUTH_ISSUER=https://auth.example.com/
KIN_OAUTH_JWKS_URI=https://auth.example.com/.well-known/jwks.json
```

These are example values, not usable Kin credentials or registered endpoints.
The AWS stack instead provides `KIN_MCP_RESOURCE_PARAMETER`: the runtime reads
the exact canonical resource URL from SSM Parameter Store. Configure that
parameter **or** `KIN_MCP_CANONICAL_URI`, never both. API Gateway's generated
HTTPS domain is sufficient; a custom domain is optional.

`KIN_OAUTH_AUTHORIZATION_SERVER` overrides the advertised authorization-server
URL; otherwise it uses the issuer. Tokens are checked for signature, issuer,
audience/resource, expiration and recognized scopes. Ordinary MCP clients can
select `KIN_MCP_AUTH_MODE=standard` alongside the existing OAuth and membership
configuration; the default `alexa` profile keeps the Alexa discovery contract.
Changing discovery does not register a client, approve callbacks or grant
family membership. See [MCP interoperability](mcp-interoperability.md).

The authenticated runtime serves the older development simulator only when
`KIN_SERVE_SIMULATOR=true`. The production family workspace has separate browser
authentication and membership gates; do not enable a development surface to
work around failed sign-in.

### Select storage and the family's calendar

`KIN_DYNAMODB_TABLE` selects persistent care storage. `KIN_CIRCLE_ID` identifies
the configured circle, `AWS_REGION` selects its region and `KIN_TIME_ZONE` is an
IANA identifier such as `America/Denver`. With no table configured, the local
server uses an in-memory store. Defaults are `demo-family` and `UTC`; choose the
intended family and time zone explicitly for an authorized cloud deployment.

The current deployment serves one configured circle. Creating another account
does not create an isolated family. Cognito owns account credentials; active
circle membership and role authorize care operations. A roster name alone is
not access. See the [family workspace guide](../docs-site/content/family-workspace.md).

### Preserve review and retry semantics

Confirmation requests include an idempotency key and the exact task snapshot
reviewed by the person. Missing or changed reviews cannot save a new reply.
Storage atomically updates the task and its receipt; an uncertain retry keeps
the original request ID and payload rather than creating a second action.
Signed-in Ask Kin follows the same MCP contract and exposes a bounded request
trace. Interpretation proposes a change; explicit confirmation performs it.

Reviewed next-week proposals preserve existing assignments and fill uncovered
days using recently assigned responsibility, not a measurement of actual
caregiving effort. Individual duty handoffs change the selected day's coverage;
queued alerts keep their original recipient. Local-day boundaries account for
daylight-saving changes. The architecture and enforcement choices are in
[architecture](architecture.md) and the
[family workspace guide](../docs-site/content/family-workspace.md).

## Cloud commands are not local diagnostics

The following commands act on the configured real table or transport. They
require separately authorized profiles, destinations and scopes. Do not run
them to make a demo look populated, reset production or test one notification.

### Initialize a new circle once

After separately reviewing `AWS_PROFILE`, `AWS_REGION`, `KIN_DYNAMODB_TABLE`
and `KIN_CIRCLE_ID`, the initialization command is:

```sh
npm run seed:aws
```

This makes real DynamoDB writes. It atomically inserts only missing seed rows
and the initial plan version, and refuses seeding once plan control exists.
A concurrent pause or task write prevents partial initialization. Use reviewed
workspace operations for subsequent care-plan changes.

### Treat a manual sweep as a delivery operation

In addition to the table, circle, region and time zone, the manual SNS path
requires an explicitly approved `KIN_ALERT_TOPIC_ARN`:

```sh
npm run sweep:aws
```

**This is a full-circle sweep that bypasses the deployed worker's pause. It may
publish real messages.** Do not use it for a bounded one-message acceptance test
or before recipient consent and routing are verified. The existence of this SNS
implementation does not prove SMS delivery; observed handset acceptance used
web push. An uncertain send must be reconciled against its durable delivery
record and provider result before any retry; do not infer permission to resend.

Automatic processing uses a separate worker and scheduler with independent
pause controls. Durable outbox records freeze the intended caregiver; a later
duty change does not redirect an existing retry. A conditional lease limits
competing senders but does not guarantee exactly-once delivery. Ambiguous
provider or receipt-write outcomes are retained for reconciliation, not treated
as permission to resend. Provider acceptance is not physical handset receipt.

An incomplete `not_yet` response starts the grace period from the later of its
due time or latest reply, 30 minutes by default; an identical retry preserves
that timestamp. This does not cancel queued, in-flight or delivered alerts.
Sweeps evaluate tasks due today or yesterday in the circle's calendar, not an
indefinite history. Today separately retains unacknowledged follow-ups across
rollover. Acknowledgment records that a follow-up was seen; it does not complete
the check-in or cancel delivery. Bounded incomplete history reads report their
limitation rather than presenting a falsely empty list.

### Generate a weekly brief from recorded facts

After reviewing the same real-table configuration, the scoped application role
and an explicit `KIN_BEDROCK_MODEL_ID` such as `amazon.nova-micro-v1:0`:

```sh
npm run brief:aws
```

This reads real family records and may incur model charges. It is not a
synthetic diagnostic. In the application, omitting the model ID selects an
evidence-linked deterministic brief. With a model configured, Bedrock ranks
recorded events and selects allowed follow-up categories; Kin renders sentences
from stored facts. Unknown evidence, inapplicable categories, invalid output or
generation failure take the deterministic fallback.

MCP's model wait defaults to 300 ms (`KIN_BEDROCK_TIMEOUT_MS`). Authenticated
REST Week has its separate 5,000 ms budget
(`KIN_WORKSPACE_BEDROCK_TIMEOUT_MS`, decimal integer 50–5000); browser Ask Kin
still uses MCP's budget. These limit model waiting, not authentication or
database time. Model calls make one SDK attempt and abort at the deadline.
The offline `brief:aws` command accepts `KIN_BEDROCK_TIMEOUT_MS` from 50–10000 ms,
default 300. These are waiting budgets, not a guarantee about total response time.

## Prepare infrastructure without deploying it

```sh
npm run infra:synth
```

This bundles Lambda assets and emits a CloudFormation template; it is not a
deployment. The data stack uses on-demand billing, AWS-managed encryption,
seven-day point-in-time recovery, deletion protection and retain-on-delete.
Deployments require an explicitly chosen non-root principal, fresh live
configuration baselines, reviewed code/configuration differences and recoverable
previous artifacts. Review the four stack definitions under `infra/` before
using CDK to deploy to an authorized account. Synthesis itself does not create
AWS resources or establish that a future deployment is free of charges.

The escalation worker and scheduler have separate CloudFormation controls;
both must be enabled for new scheduled processing. A pause is not proof that
in-flight delivery has stopped or queues have drained. Reminder reconciliation
has its own controls. Treat activation, IAM changes, alarms and delivery tests
as separate operational decisions, not automatic steps of a code update.

The separate classic Alexa development skill connects the linked Echo account
to Kin; it is not native Alexa+ Toolkit access or Skills Store publication.
The [importable interaction model](../alexa/interaction-model-en-US.json) is
the model source; the [Echo and MCP guide](../docs-site/content/echo-and-mcp.md)
explains the account-linking and device boundary. Kin coordinates care; it does not verify
safety, identify the physical speaker or provide medical or emergency services.
