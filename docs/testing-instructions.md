# Test Kin without a live family account

Start with the public [Judges: start here guide](https://kin.gowthamsarveswaran.com/how-kin-works.html#judges).
The guide explains the two review routes; it does not grant family access or
publish a password. Use the local story below for a complete, credential-free
interactive test.

The isolated local story demonstrates Kin's complete check-in loop using real
Streamable HTTP MCP calls and shared application state. It requires repository
access and Node **22.23.2**, but no AWS credentials, Kin account, Echo, microphone,
phone permission or paid model. People, calendar time, Alexa dialogue and the
notification are explicitly simulated. This is not native Alexa+ toolkit access
or evidence of delivery to a physical phone.

## Start the story

From a checkout of this repository, with the pinned Node version active:

```sh
npm ci --ignore-scripts --no-audit --fund=false
npm run build
npm run demo:story
```

Open <http://127.0.0.1:3030/story.html>. The terminal should report
`Kin local story:`. Leave it running while testing. If port 3030 is occupied,
stop the conflicting local process you own before starting; do not expose this
demonstration through a tunnel or public proxy.

## Follow one parent reply through the family circle

1. In Evelyn's conversation, choose **Not yet**, then **Review request** and
   **Confirm this check-in**. Choosing an example only fills a draft; reviewing
   does not save it. After confirmation, the caregiver view records the reply
   while the check-in remains incomplete.
2. Advance the story clock to **9:31 AM**. The actual escalation logic records
   a simulated follow-up for Theo after the ordinary 30-minute grace period.
   This control accelerates synthetic time, not a live AWS schedule.
3. Acknowledge the follow-up in Theo's view. Confirm that Evelyn's check-in
   remains incomplete. Acknowledgment means seen, not contacted or completed.
4. Draft **Done**, review it and confirm. The caregiver view should show the
   recorded completion. Open the weekly brief and inspect its source evidence.
5. Inspect the MCP trace for actual requests and validated results. A trace is
   technical evidence, not verification of speaker identity or handset delivery.

Do not use the optional Bedrock mode or dictation for this credential-free
route. Restart the story process to reset its synthetic data; refreshing the
page does not reset server state. Never run cloud seeding or a live missed-task
sweep to reset the story.

See the [reviewer guide](reviewer-guide.md) for an unaided task checklist and
the [README](../README.md) for architecture and additional verification.

## If the story does not open

- Confirm that Node reports the pinned version from `.nvmrc` and that you ran
  the commands from the repository root.
- Leave the terminal running and use the loopback URL it reports. Do not try
  the hosted workspace's `/story.html` path: the isolated story is intentionally
  absent from the production deployment.
- If you see a sign-in page, you opened the hosted family workspace rather
  than the local story. Return to <http://127.0.0.1:3030/story.html>.
- If a save has an uncertain result, use the story's retry control rather than
  drafting the action again. Restart only when you want to reset all synthetic
  activity.

## What the hosted deployment shows

The [public homepage](https://kin.gowthamsarveswaran.com/) explains the product.
The [family workspace](https://n75ek9ymt0.execute-api.us-east-1.amazonaws.com/invite.html)
requires an explicitly authorized account and family membership. A roster name
alone does not grant access. A new caregiver account is not automatically an
isolated test family: the current deployment serves one configured circle.

Dedicated live reviewer access has not been provisioned by these instructions.
Do not use the owner's credentials or assume permission to view the existing
family's history. If separately arranged, live reviewer credentials belong only
in the private testing instructions supplied to judges, never in source,
screenshots, video, public project text or this file. Verify the visibility of
the submission field before placing any credentials there.

At the last verified deployment, general automatic missed-check-in processing
was off and reminder reconciliation was on. The owner has physically used a
linked Echo Pop through the **classic Alexa development skill**, invoked with
“Alexa, open kin family.” That device evidence is separate from the local
Alexa+-style simulation and is not a public Skills Store or native Alexa+ claim.
The September 23 bounded scheduled-worker test has its own
[dated acceptance record](recurring-acceptance-20260923.md); it is not a current
always-on delivery promise.

Kin coordinates everyday care. It does not establish whether somebody is safe,
identify who is speaking, recommend treatment or provide emergency monitoring.
