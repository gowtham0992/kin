# Kin — developer friction log

Gowtham Sarveswaran · Amazon Developer Hackathon 2026

These entries describe problems encountered while building and testing Kin. Severity reflects the impact on this project, not a platform-wide incident. Some issues were in Kin's implementation; those are identified below. No account credentials or family records are included. This log was prepared on October 23, 2026 from development notes and physical-device test reports; it is not a controlled usability study.

The most useful improvement would be a clear path from a working MCP server to a real-device test. Once connected, the next friction was diagnosis: a short spoken error did not tell me which boundary had failed.

| Area | Impact on Kin | Outcome |
| --- | --- | --- |
| Native Alexa+ testing access | High | Worked around with a classic Alexa development skill; native integration remains unverified |
| Invocation setup and recognition | Medium | Tested launch phrase standardized as “open kin family” |
| Voice request deadlines | High | Kin deadlines adjusted; subsequent physical tests succeeded |
| Reminder result and time serialization | High | Kin diagnostics and serializer corrected; later creation and cancellation observed |

“High” means a core integration or safe test was blocked. “Medium” means setup or diagnosis required extra steps. These are project-specific ratings, not estimates of affected users.

## 1. Testing a working MCP server through Alexa+

**Severity: High — blocked the intended native integration test.**

**Task attempted:** Connect Kin's self-hosted MCP server to a real Alexa voice experience.

**Steps taken:** Implemented the MCP server and its tools, tested the web conversation against it, and investigated the Alexa+ integration path. Native Alexa+ Toolkit access was not available to this project.

**Expected:** A developer testing path that would let me exercise the MCP integration on my Echo before preparing the submission.

**Actual:** I could test MCP independently, but could not validate a native Alexa+ Toolkit integration. Having a working MCP server did not provide that access.

**Workaround used:** Built a separate classic Alexa development skill that calls Kin's MCP server through a linked account. Tested that path on a real Echo Pop. The local reviewer story also exercises real MCP calls, but its Alexa dialogue and notifications are simulated. Neither is presented as native Alexa+ Toolkit integration.

**Actionable suggestion:** Provide a self-service developer sandbox, visible access prerequisites and an end-to-end guide from a running MCP server to an Echo test. Clearly distinguish what can be tested without Toolkit access.

**A useful acceptance test:** A developer with an Echo and a conforming MCP server can determine eligibility, complete the supported onboarding path and inspect a successful tool call without needing an unpublished access arrangement.

**Implementation reference:** [Kin's MCP integration boundary](mcp-interoperability.md). This documents what is implemented, not proof of native Alexa+ access.

## 2. Skill discovery, invocation names and speech recognition

**Severity: Medium — prevented the first successful launch.**

**Task attempted:** Open the enabled Kin skill on an Echo Pop by voice.

**Steps taken:** Enabled the skill in the Alexa app and said “Alexa, open kin care.” Inspected the skill page and Alexa's voice history after launch failed.

**Expected:** Alexa would launch the skill using the name I associated with it in the app.

**Actual:** Alexa responded, “I'm not quite sure how to help you with that.” Early app metadata still showed the starter phrase “Alexa open hello world.” Other attempts appeared in voice history as “kincaid” and “kit kat.” These observations exposed both our setup inconsistency and recognition ambiguity; they do not establish a single platform defect.

**Workaround used:** Corrected and tested the invocation configuration, inspected recognized utterances, and standardized the tested phrase as “Alexa, open kin family.” The physical device then launched the skill successfully.

**Actionable suggestion:** Add a developer-console preflight that compares the configured invocation name with example phrases and displays the exact phrase to test. A failed-launch diagnostic that distinguishes recognition mismatch from skill lookup failure would shorten troubleshooting.

**A useful acceptance test:** Before testing, the console flags starter phrases that do not match the configured invocation. After a failed launch, it shows the recognized phrase and whether the skill was matched.

**Implementation reference:** [The tested interaction model](../alexa/interaction-model-en-US.json).

## 3. Keeping the linked family-plan read within a voice response budget

**Severity: High — the device could launch but fail to read the plan.**

**Task attempted:** Read today's family check-ins through the linked Echo account and MCP backend.

**Steps taken:** Launched the skill on the physical Echo, compared its failure response with backend diagnostics, and reviewed the deadlines across the Echo Lambda and MCP client.

**Expected:** The linked plan would load and Alexa would speak it promptly.

**Actual:** Repeated tests returned “I couldn't load the family plan right now. Please try again shortly.” Our initial MCP client deadline was 3.5 seconds and the Echo Lambda timeout was 5 seconds. The spoken error alone did not identify which stage had failed.

**Workaround used:** Raised Kin's MCP deadline to 5 seconds and the Echo Lambda timeout to 7 seconds, added focused deadline tests, and continued physical-device validation. This was a mitigation in our application, not an extension of Alexa's response window. Later idle-device tests produced a plan response in roughly 3–4 seconds, measured informally by the tester.

**Actionable suggestion:** Provide an end-to-end latency-budget example for skills calling authenticated external tools, plus a correlation identifier visible across the console, skill request and tool call. Separate authentication, transport, tool execution and response-validation timings would make generic failure speech easier to diagnose.

**A useful acceptance test:** One failed device request can be traced to the stage that exhausted its budget without logging family content or credentials. I am requesting easier cross-system diagnosis, not removal of the voice-response deadline.

**Implementation references:** [MCP client](../src/echo-care-client.ts) and [client regression tests](../test/echo-care-client.test.ts).

## 4. An uncertain reminder result required several distinct checks

**Severity: High — retrying without knowing the outcome could create duplicates.**

**Task attempted:** Create one discreet Alexa reminder after explicit voice consent.

**Steps taken:** Requested a reminder for a labeled test check-in, answered yes, checked the Alexa app, and inspected narrowly scoped diagnostic records.

**Expected:** A confirmed creation receipt and one visible reminder, or a clear rejection that could be safely corrected.

**Actual:** Early attempts produced Kin's uncertain-acceptance response, and the tester reported no reminder in the app. The initial evidence did not establish whether the problem was transport, claim handling or receipt parsing. After adding diagnostics, a later attempt showed HTTP 400 in 103 milliseconds: that attempt was rejected, not timed out.

**Workaround used:** Kept automatic retries disabled, asked the tester to inspect the app, and added diagnostics containing only fixed outcome categories, timings and HTTP status—not tokens or reminder content. Corrected Kin's absolute-time serializer to send a UTC clock value without a trailing Z, paired with Etc/UTC. Later physical testing confirmed acceptance and a visible reminder; a subsequent cancellation test confirmed its removal.

**Actionable suggestion:** Make scheduledTime and timeZoneId examples and validation errors unambiguous. Provide or clearly document a client-supplied idempotency/reconciliation mechanism for uncertain create outcomes. Missing diagnostics in our client were also part of this problem; not every uncertain result was evidence of a provider failure.

**A useful acceptance test:** A developer can identify an invalid scheduled-time field from a structured error, and can distinguish “definitely rejected” from “may have been accepted” without blindly resending the request. This is a request for a clearer supported path, not a claim that no relevant platform capability exists.

**Implementation references:** [Reminder transport and diagnostics](../src/echo-reminders.ts), [scheduled-time regression tests](../test/echo-reminder-time-format.test.ts), and [diagnostic privacy tests](../test/echo-reminder-diagnostics.test.ts). These tests verify Kin's behavior; physical receipt was checked separately.

## Scope of this feedback

This log is a retrospective of observed development friction, not a claim that every issue remains unresolved. The public source and local walkthrough are available at https://github.com/gowtham0992/kin. The hosted reviewer account is read-only. Automatic missed-check-in notifications are currently disabled; this log does not claim ongoing delivery or production reliability.
