---
title: Real voice. Real MCP.
sidebar_label: Echo and MCP
description: Understand Kin's classic Echo skill, its web conversation and its standards-based MCP server.
---

Kin's connected surfaces work with the same family plan. The voice connection,
web conversation and local story have different boundaries; one is not proof
that the others are connected.

## The linked Echo

The working physical-device integration uses a **classic Alexa development
skill** on a linked Echo Pop. The tested invocation is:

> Alexa, open kin family.

The skill reads Kin's plan through its self-hosted MCP server using the linked
family account. Follow the actual prompts. If no check-in is waiting for
confirmation, saying “yes” alone does not choose one or record a reply.

This is not an intercom: family members do not exchange voice messages through
the two sides of Kin. The parent's recorded response becomes shared care state
for the family to review.

The development skill is not a public Skills Store listing. Linking an account
does not identify the physical speaker; anyone able to use the linked device
may act with that account's permissions.

## The Kin web conversation

**Ask Kin** is Kin's own browser interface. Its reviewed reads and saves use real
MCP calls. It is not Amazon's Alexa+ interface and does not connect browser
dictation to an Echo.

The isolated local story also uses real MCP, but its people, clock, dialogue
surface and notification display are synthetic. It has no physical Alexa or
phone connection.

## The MCP server

**Model Context Protocol (MCP)** is the interface through which authorized
clients discover and call Kin's tools. Kin supports the `2025-11-25` protocol
baseline using Streamable HTTP, with an MCP Apps Today widget.

The main tools are:

| Tool | Purpose |
| --- | --- |
| `show_today` | Read the current care plan and recorded state. |
| `confirm_care_task` | Save a reviewed done, not-yet or skipped response. |
| `show_weekly_brief` | Read the evidence-linked weekly summary. |

Additional tools are exposed only when their feature and permission gates are
enabled. These support reviewed plan cancellation, recent completion undo and
consent-ticket preparation for an Echo reminder.

Standard MCP clients use configured OAuth discovery and sign-in. Access tokens
are bound to the intended resource, and current circle membership determines
what the account may do. A registered client or successfully issued token does
not grant circle access by itself.

## Reminders need their own consent

When available, an Echo reminder requires an explicit offer and consent. Anyone
nearby may hear it. Kin can request cancellation when the related check-in no
longer needs the reminder, but cancellation can be delayed or fail. Manage
reminders in the Alexa app if the result is uncertain; do not create duplicates
to work around an unverified result.

## What “Alexa+” means here

Kin is built for the Amazon Developer Hackathon's **Alexa+ self-hosted MCP
route**. Its standards-based MCP implementation and separate classic Alexa
development skill are real code paths. They do not establish native Alexa+
Toolkit access or a native Alexa+ add-on deployment.

[Read the developer overview →](./for-developers.md)
