---
title: Try one complete care story
sidebar_label: Try the story
description: Run Kin's isolated care loop without a family account, AWS credentials or an Echo.
---

The local story lets you follow a parent's reply through the family's shared
plan. It uses real local MCP calls and shared application state, with synthetic
people, calendar time, history and notifications. It does not connect to an Echo
or send an alert to a phone.

## Start locally

You need a checkout of the [Kin repository](https://github.com/gowtham0992/kin)
and **Node 22.23.2**, the version pinned in its `.nvmrc`. From a checkout, run
these commands at the repository root:

```sh
npm ci --ignore-scripts --no-audit --fund=false
npm run build
npm run demo:story
```

Open **http://127.0.0.1:3030/story.html**. The terminal should print
`Kin local story:`. Leave the process running while you try it.

No Kin account, AWS credentials, Echo, microphone or phone permission is needed
for this route. The default launch makes no AWS model or notification calls.
Use typing and the example replies; optional dictation may use the browser's
speech provider.

## 1. Record a reply, not an assumption

In Evelyn's conversation, choose **Not yet**, then **Review request**. Check the
selected check-in and proposed response. Nothing is saved by choosing an example
or opening the review.

Choose **Confirm this check-in**. Theo's family view should record the reply
while the check-in remains incomplete.

## 2. Follow up without completing the check-in

Advance the story clock to **9:31 AM**. The application runs its actual
escalation logic after the ordinary 30-minute grace period, using the synthetic
clock and notification display. No live schedule is accelerated and no phone
message is sent.

Acknowledge the follow-up in Theo's view. Evelyn's check-in should still be
incomplete. **Acknowledgment means seen, not completed.**

## 3. See the result and its evidence

Draft **Done**, review it and confirm it separately. The family view should
show the recorded completion.

Open the weekly brief and inspect its source facts. The story includes six
days of synthetic history. The displayed brief is evidence-linked; it is not a
health or safety assessment.

Expand the MCP evidence panel to inspect real local requests and results. Its
timings are local round trips, not physical Echo response times or phone receipt.

## Reset or recover

- **Reset the story:** stop the terminal process with `Ctrl+C`, then run
  `npm run demo:story` again. Reloading the page does not reset server state.
- **The page will not open:** leave the process running, check the pinned Node
  version and open the loopback address printed in the terminal. If the port is
  occupied, stop only the conflicting process you own.
- **You see sign-in:** you opened the hosted family workspace, not the local
  story. Return to the loopback URL above.
- **A save has an uncertain result:** use the same-request retry control. Do
  not draft another confirmation just to retry an unknown outcome.

Keep the story on loopback. Do not expose it through a public tunnel, enter
real family information, run cloud seeding or use a live notification sweep to
reset it. Optional paid-model configuration is not needed for this walkthrough.

[Understand the family workspace →](./family-workspace.md)
