import { App } from "aws-cdk-lib";
import { KinReminderSyncStack } from "./kin-reminder-sync-stack.js";

// Deliberately separate from both existing apps. Synthesis never activates
// processing; deployment still needs its independently reviewed boundary/role.
const app = new App();
new KinReminderSyncStack(app, "KinReminderSyncStack", {
  env: { region: "us-east-1" }, terminationProtection: true,
  careTableName: "kin-care-state", circleId: "demo-family",
});
