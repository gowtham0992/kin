import { App } from "aws-cdk-lib";
import { KinEchoStack } from "./kin-echo-stack.js";

const app = new App();
new KinEchoStack(app, "KinEchoStack", {
  env: { region: "us-east-1" },
  terminationProtection: true,
});
