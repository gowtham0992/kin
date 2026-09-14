# Run the local family-care story

Kin’s local story demonstrates a reviewed parent reply, a shared family update, a missed-task follow-up, and an evidence-backed weekly brief. Care changes use the real local MCP server; people, history, time, and notifications are synthetic. It is not an Alexa device integration.

## Start without AWS

From the repository root, with the project’s dependencies installed:

```sh
npm run demo:story
```

Open [the local story](http://127.0.0.1:3030/story.html). The command builds the browser assets, binds to `127.0.0.1`, and creates an isolated in-memory care store. The default launch creates no AWS client and makes no model or notification-provider calls, even if AWS configuration is present in the shell. Optional browser dictation has its own speech-provider boundary, described below.

The story starts at **9:00 AM on September 8, 2026, America/Denver**. It does not use the computer’s current date. `PORT` can select another port between 1024 and 65535. Stop the command with Ctrl+C and restart it to reset the synthetic story. Reloading the page does not reset the server’s care state or model-attempt count.

Keep this server local. Do not publish it, expose it through a tunnel, or enter real family information. It uses synthetic identities rather than the signed-in family workspace; loopback, host, and same-origin checks are not a replacement for production authentication.

## Walk through one check-in

1. Choose **Show today**, then **Review request**. The shortcut only fills a draft; the submitted command reads today’s plan through MCP.
2. Choose **Not yet**, then **Review request**. Check the proposed task, due time, and response. Nothing has been saved yet.
3. Choose **Confirm this check-in**. The local MCP tool saves Evelyn’s reported response. Theo’s panel reads the same store separately through the family REST API.
4. Choose **Advance demo clock to 9:31 AM**. The server runs the escalation sweep after the 30-minute grace period. The displayed notification is simulated; no SMS is sent.
5. Choose **Theo: acknowledge follow-up**. This records that Theo saw the follow-up. It does not complete Evelyn’s task or confirm her safety.
6. Draft **Done**, review it, and confirm it separately when demonstrating a later completed reply.
7. Choose **Read the weekly brief**. Its deterministic summary uses six days of synthetic history and today’s recorded activity. Expand its source facts to inspect the evidence. Enabling Nova for conversation does not change this brief into a model-generated one.

The family panel refreshes every five seconds while the page is visible and no conflicting action is pending. **Behind the scenes · MCP evidence** shows bounded client observations, including tool calls and receipt identifiers. Those local round-trip timings are not Alexa-device latency.

If a save loses its acknowledgement, use **Retry the same check-in**. Other actions remain locked until that same request is resolved. Editing a draft invalidates its review, and a task that changed before confirmation requires a new review. **Leave unchanged** closes the review without saving.

## Enable Nova only when you intend to use AWS

Natural-language interpretation is optional. Replace `your-kin-application-profile` below with an existing, explicitly chosen AWS application profile whose use you have authorized:

```sh
AWS_PROFILE=your-kin-application-profile npm run demo:story -- --bedrock
```

The launcher selects Amazon Nova Micro (`amazon.nova-micro-v1:0`) in `us-east-1`. It resolves the named profile directly rather than falling back to another ambient identity. The command does not create permissions, sign in, deploy infrastructure, or prove that the profile can invoke the model.

The Bedrock launch refuses conflicting `AWS_REGION` values and ambient `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, or `AWS_BEARER_TOKEN_BEDROCK` variables, including empty values. Resolve that configuration deliberately before retrying; do not substitute root or an unrelated project’s credentials.

Starting with `--bedrock` makes the option available; it does not send a model request. In the page:

1. Type a synthetic report, such as “I haven’t had my glass of water yet.”
2. Check **Use Nova for this request** after reading the disclosure.
3. Choose **Review with Nova**. Only then does Kin send that draft and synthetic task labels to Amazon Bedrock for interpretation.
4. Inspect the proposed response and choose **Confirm this check-in** separately if it is correct.

The checkbox is consumed once and cleared by typing, choosing a shortcut, or starting dictation. An unchecked request uses the local exact-command interpreter, even when Nova is configured. A model suggestion cannot save a care task. “Yes” alone is not a care report or permission to auto-save.

After a proposal, a follow-up such as “I did it” can refer to the reviewed task through a server-issued context token. The server checks that context against current task state. A follow-up still produces a new review rather than a write.

### Model attempts are bounded, not free

Each server process allows **20 opted-in model attempts**, including failed attempts. The page displays the count. Reaching the limit disables the Nova option; exact commands remain usable. This is a per-process guard, not a dollar budget: restarting the server resets the allowance, and AWS charges or credit consumption may apply.

The route has a **five-second caller deadline**. A timeout does not prove the credential lookup or provider request stopped. Kin keeps that attempt reserved until its underlying operation settles, rejecting overlapping model requests as busy. It does not retry model calls automatically; the AWS client is also configured for one attempt. Exact local commands remain available while a model request is busy or unavailable.

On a model error, keep or edit the retained draft. Use an exact command without Nova, or explicitly opt in to a new model review when available. If an operation never settles, restarting the isolated server clears its local state; a restart does not undo a provider charge.

## Dictation fills a draft; it never submits one

**Use voice input** is optional and starts recognition only after a click. The browser may send audio to its speech-service provider. This is separate from the Nova checkbox: microphone permission does not authorize sending a draft to Bedrock.

While listening, the draft and conflicting actions are disabled. **Stop listening** finishes the capture; **Cancel dictation** stays available while the browser finishes. Recognized words are appended to the draft only after recognition ends. Edit them before choosing a review action. The combined draft is limited to 800 characters; oversized or failed dictation preserves the earlier text.

Cancellation, hiding the page, or leaving it discards unfinished dictation and ignores late callbacks. Unsupported browsers, microphone denial, and speech-service failures retain the typed path. The browser tests inject a speech-service stand-in; they do not record audio or verify real microphone behavior.

## Run the checked-in browser checks

Build the assets first:

```sh
npm run build
```

Playwright is a pinned development dependency, installed by `npm ci`. Install
its Chromium browser once, then run both checks with the project's own script:

```sh
npx --no-install playwright install chromium
npm run test:browser
```

Screenshots and JSON results default to `/tmp/kin-story-browser` and
`/tmp/kin-story-inputs-browser`. `KIN_BROWSER_CHANNEL=chrome` selects an installed
Chrome channel instead of Playwright's Chromium. `KIN_PLAYWRIGHT_MODULE` remains
an optional override for an external installation; it is not needed for the
normal quickstart. The first script starts its own default story server on port
3038, which must be free. The second starts a synthetic-model fixture on an
available loopback port. Neither requires the manually started story server.

`verify-story-browser.mjs` exercises real local MCP writes, separate family reads, the clock advance, simulated follow-up, acknowledgement, same-receipt retry after a lost response, and the grounded brief. It also checks that an unavailable story endpoint blocks care reads.

`verify-story-inputs-browser.mjs` substitutes only the model and speech service. It checks opt-in, draft-only dictation, stop/cancel controls, context follow-ups, separate confirmation, typed fallback, touch targets, contrast, and overflow. Both scripts capture screenshots at 375, 768, and 1280 pixels and report a JSON result; inspect the screenshots as well as the assertions.

These checks are local evidence. They do not establish real Nova access, microphone support on a particular device, production family authentication, SMS delivery, or official Alexa/Echo compatibility.

For the implementation boundaries, see [the isolated server](../src/local-story.ts), [launch policy](../src/local-story-launch.ts), [named-profile client](../src/local-story-bedrock.ts), and [story UI](../simulator/story.js). Standard authenticated MCP compatibility is documented separately in [MCP interoperability](mcp-interoperability.md).
