---
title: Build around one shared plan
sidebar_label: Developer overview
description: The architecture and reviewed-write contract behind Kin's connected surfaces.
---

Kin's application is a TypeScript service with a self-hosted MCP interface and
an authenticated family web workspace. This page explains the boundaries; it
is not a cloud deployment, credential or notification-activation runbook.

## One state, separate readers

The MCP tools and family HTTP API use the same care repository. The isolated
story runs an in-memory repository: the conversation writes through real local
Streamable HTTP MCP, while the family view reads independently through HTTP.
This lets a reviewer inspect shared-state behavior without cloud credentials.

The AWS deployment uses DynamoDB for persistent care state and OAuth state.
API Gateway fronts separately packaged application and authorization runtimes
on Lambda. The classic Echo skill acts as an authenticated MCP client.

## Review is part of the write contract

A care confirmation includes the selected task, requested response, unique
idempotency key and the exact task snapshot reviewed with the person. The server
checks current membership and task state before committing a change.

The task update and receipt are atomic. If a response is lost after a successful
commit, retry the identical request with the same key. Do not create a fresh
request to resolve an uncertain result. If task state changed after review,
obtain a new review rather than overwriting the newer record.

The browser's interpretation step only proposes a draft. An explicit
confirmation performs the MCP write. Feature-gated undo and plan-cancellation
operations have their own reviewed contracts; they are not generic rollback
operations.

## Authentication does not replace membership

OAuth discovery advertises the configured resource. Kin validates token
signature, issuer, audience/resource, expiration and recognized scopes. Current
circle membership and role constrain the actual operation.

The unauthenticated loopback story is deliberately separate from the hosted
workspace. It must not be exposed as a public demo server or used to bypass
production sign-in. A newly registered account does not create an isolated
family or grant access to an existing circle.

## Follow-ups have durable state

When enabled, the scheduled worker evaluates eligible unanswered check-ins and
uses a durable outbox. Delivery records retain their intended caregiver even
if duty assignments change afterward. A conditional lease limits competing
senders; it does not guarantee exactly-once delivery.

Ambiguous delivery outcomes require reconciliation, not blind resending. A
caregiver acknowledgment is separate from a care response. The workspace must
not present an incomplete history read as a healthy empty list.

General recurring processing is currently off. Do not enable it or run a
manual cloud sweep merely to test the UI. The local story has an isolated,
synthetic clock and notification display for that purpose.

## Briefs stay grounded

Weekly briefs use recorded activity with evidence references. When configured,
Amazon Bedrock selects allowed observations; Kin validates the selection and
renders text from stored facts. Missing, invalid or unavailable model output
uses an evidence-linked deterministic fallback. A generated sentence is never
a substitute for a stored care event or a medical assessment.

## Verify the layer you changed

From an authorized checkout, with pinned Node 22.23.2:

```sh
npm run check
```

That command builds the app and runs its unit/integration suite. Browser
journeys have a separate gate:

```sh
npx --no-install playwright install chromium
npm run test:browser
npm run test:browser:today
```

These checks use synthetic local data. They do not prove physical Echo
behavior, real-account onboarding or handset receipt. Live acceptance needs
its own explicit, bounded test with consent and independently verified results.

[Start with the local care story →](./quickstart.md)
