# Test Kin without a live family account

Use the local story below for a complete, credential-free interactive test.
The public [How Kin works guide](https://kin.gowthamsarveswaran.com/how-kin-works.html)
also explains the product; neither route grants access to a live family or
publishes an account password.

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

See the [README](../README.md) for product navigation and the
[developer guide](development.md) for architecture and additional verification.

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

These instructions do not provision an account or membership. Use only an
explicitly authorized account and agreed test data; never borrow someone else's
credentials or assume permission to inspect their family's history. Do not
publish credentials in source, screenshots or shared material.

Automatic missed-check-in processing and reminder reconciliation are separately
configured. A successful local test does not establish that either live worker
is enabled or that a phone notification was delivered. The Echo connection is
a **classic Alexa development skill**, invoked with “Alexa, open kin family,”
through a linked account. It is not a public Skills Store listing or proof of
native Alexa+ Toolkit access.

Kin coordinates everyday care. It does not establish whether somebody is safe,
identify who is speaking, recommend treatment or provide emergency monitoring.
