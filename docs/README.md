# Kin documentation

Kin gives a family one shared place for everyday check-ins, replies and the
next turn at care. Start with the guide for your task; implementation notes and
dated release records are kept separate from the product introduction.

## Start here

The product guide, **[Kin Docs](https://gowtham0992.github.io/kin/)**, was
published and verified, then taken offline by the owner's repository privacy
change. Until it is republished, read the
[curated source guides](../docs-site/content/intro.mdx) here. This repository hub
also links developer references and dated operator records that are deliberately
excluded from the documentation website.

| You want to… | Open |
| --- | --- |
| Understand how a family uses Kin | [How Kin works](https://kin.gowthamsarveswaran.com/how-kin-works.html) |
| Try the complete care loop without a family account | [Testing instructions](testing-instructions.md) |
| Review Kin without a guided walkthrough | [Reviewer guide](reviewer-guide.md) |
| Run or change the code | [Developer guide](development.md) |

The local story uses real MCP calls with synthetic people, time and
notifications. It needs no AWS credentials or paid model. The hosted family
workspace requires an authorized account and membership; documentation never
grants access or supplies the owner's credentials.

## Build and integrate

- [Developer guide](development.md) — local setup, configuration, verification
  and the boundaries around cloud commands.
- [Architecture](architecture.md) — the system's responsibilities and design
  decisions.
- [MCP interoperability](mcp-interoperability.md) — resource-bound OAuth,
  scopes, registered clients and the reviewed-write contract. Its dated test
  counts describe that milestone, not the latest source.
- [Local story guide](story-demo.md) — the isolated care loop, reset behavior,
  optional dictation and separately opted-in Bedrock use.
- [Alexa interaction model](../alexa/interaction-model-en-US.json) — the
  current importable classic Alexa development-skill model. The
  [Echo setup](echo-pop-setup.md) and [linked-care](echo-linked-care.md)
  documents are historical integration records, not the current voice script
  or rollout status. This integration is distinct from native Alexa+ Toolkit
  access.

## Operate an authorized deployment

These are operator references, not steps needed to try the local story.

- [AWS deployment](aws-deployment.md) and [release controls](release-controls.md)
  cover scoped access, artifact review and worker gates.
- [Family access](family-access.md), [invitations](invitations.md) and
  [roster management](roster-management.md) distinguish an account, a circle
  membership and a roster entry.
- [Delivery operations](delivery-operations.md) describes durable delivery
  state, ambiguous outcomes and reconciliation.
- [Final acceptance runbook](final-acceptance-runbook.md) separates software
  checks from physical Echo and phone evidence.

Read [current status](../STATUS.md) before using an older runbook. A source
feature, successful local test or historical enabled flag does not establish
the current production configuration. General recurring follow-up processing
was last verified off; reminder reconciliation was on. Historical alarm setup
does not describe the owner's current no-alarms deployment.

## Release evidence stays dated

[Current status](../STATUS.md) and the
[October 21 release record](security-docs-release-20261021.md) distinguish
deployed code, preserved configuration and remaining filming checks. The
[earlier readiness record](filming-readiness-20261021.md) preserves preparation
evidence, not the latest deployment state. Dated documents in
this directory preserve earlier decisions, test results and acceptance records;
their presence does not make them current instructions.

## Publishing the documentation

[Kin Docs](https://gowtham0992.github.io/kin/), currently offline while this
repository is private, is built from the six explicitly
allowlisted pages in [`docs-site/content/`](../docs-site/content/), not this
directory. Its source stays in the existing Kin repository; only the reviewed
static build is published to its `gh-pages` branch. See the
[site build instructions](../docs-site/README.md).

Do not point a site generator at this entire directory: it also contains
historical operator procedures, release evidence and internal review notes.
Review content, links, screenshots and metadata before any public build;
exclude credentials and private artifacts.

GitHub Free requires a public repository for Pages hosting. Making this
repository private can take the documentation site offline; it does not change
Kin's AWS-hosted application or family authentication. A paid plan's public
Pages site is not automatically private just because its source is private.

---

Kin coordinates ordinary family care. It does not establish that someone is
safe, identify the physical speaker or provide medical or emergency services.
