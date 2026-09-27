import { createLocalStoryApp } from "../src/local-story.js";
import { createBedrockIntentGenerator } from "../src/demo-conversation.js";
import { localStoryLaunch } from "../src/local-story-launch.js";
import { createLocalStoryBedrockClient } from "../src/local-story-bedrock.js";

// The default still creates no cloud client. Bedrock requires both a launch
// flag and an explicit per-request choice in the page; care and SMS stay local.
const options = localStoryLaunch(process.argv.slice(2), process.env);
if (options.help) {
  console.log("Kin local story: npm run demo:story [-- --bedrock]");
  console.log("Default: synthetic local care, limited commands, no AWS calls. Optional browser dictation may use its speech provider.");
  console.log("--bedrock: requires an explicit AWS_PROFILE; up to 20 opted-in Amazon Nova requests in us-east-1 per process. Model charges may apply.");
  process.exit(0);
}
const { port, model } = options;
const client = model ? createLocalStoryBedrockClient(model) : undefined;
const intentGenerator = model ? createBedrockIntentGenerator({ ...model, client }) : undefined;
const server = createLocalStoryApp({ intentGenerator }).listen(port, "127.0.0.1", (error?: Error) => {
  // The error listener below owns client cleanup and the unsuccessful exit.
  if (error) return;
  console.log(`Kin local story: http://127.0.0.1:${port}/story.html — synthetic data, simulated notifications, no Alexa device connection.`);
  console.log(model ? "Amazon Nova is available only for explicitly opted-in requests (20 attempts per process). AWS model charges may apply."
    : "Simple check-in replies and exact commands stay local. No AWS model or notification calls.");
  console.log("Restart this local command to reset the story.");
});
server.on("error", () => { client?.destroy(); console.error("Kin could not open the local story port. Check PORT and stop any conflicting server."); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => { client?.destroy(); process.exit(0); }));
}
