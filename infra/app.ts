import { App, BootstraplessSynthesizer } from "aws-cdk-lib";
import { KinDataStack } from "./kin-data-stack.js";

const app = new App();
new KinDataStack(app, "KinDataStack", {
  env: { region: "us-east-1" },
  synthesizer: new BootstraplessSynthesizer(),
});
