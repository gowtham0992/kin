# Kin documentation

Start with one family care story, find your way around the shared workspace,
or learn how Kin's connected surfaces work together.

## Use Kin

These guides cover the product and its boundaries. The hosted
[Kin Docs](https://gowtham0992.github.io/kin/) site is currently offline while
the repository is private; the same guide sources are available here:

| You want to… | Open |
| --- | --- |
| Understand Kin | [Meet Kin](../docs-site/content/intro.mdx) |
| Try a complete care loop without a family account | [Try the story](../docs-site/content/quickstart.md) |
| Find Today, Plan, Turns, Week and Ask Kin | [The family workspace](../docs-site/content/family-workspace.md) |
| Understand the Echo and web connections | [Echo and MCP](../docs-site/content/echo-and-mcp.md) |
| Understand consent, privacy and safety limits | [Privacy and safety](../docs-site/content/privacy-and-safety.md) |
| See how the system fits together | [Developer overview](../docs-site/content/for-developers.md) |

The local story uses real MCP calls and shared state with synthetic people,
history, time and notifications. It requires no AWS credentials, paid model or
live family account. The hosted family workspace requires authorized sign-in
and accepted circle membership; a roster name alone does not grant access.

## Run and develop Kin

- [Developer guide](development.md) — local setup, configuration and
  verification commands.
- [Architecture](architecture.md) — the shared-state model, connected surfaces
  and trust boundaries.
- [MCP interoperability](mcp-interoperability.md) — resource-bound OAuth,
  registered clients, permissions and reviewed writes.
- [Local story guide](story-demo.md) — the complete care loop, reset behavior,
  optional dictation and explicitly opted-in Bedrock mode.
- [Testing instructions](testing-instructions.md) — independently exercise
  the local story without family credentials.
- [Alexa interaction model](../alexa/interaction-model-en-US.json) — the
  importable model for Kin's classic Alexa development skill.

The working Echo connection is a classic Alexa development skill, distinct
from native Alexa+ Toolkit access. Kin's web conversation is its own interface;
it is not Amazon's Alexa+ interface. All connected surfaces use the same
reviewed-write contract rather than treating interpreted speech as permission
to change care records.

## Build the documentation

The website is built from six explicitly allowlisted pages in
[`docs-site/content/`](../docs-site/content/), independently of the application.
Its source and lockfile stay in the Kin repository; only reviewed static output
belongs on the `gh-pages` branch. See the
[documentation build instructions](../docs-site/README.md).

Documentation does not grant family access or supply account credentials.
General recurring follow-up processing is currently off in the hosted app;
notification enrollment alone does not enable automatic delivery. Kin
coordinates ordinary family care. It cannot establish that someone is safe,
identify the physical speaker or provide medical or emergency services.
