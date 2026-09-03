import { App } from "aws-cdk-lib";
import { KinDataStack } from "./kin-data-stack.js";

const app = new App();
new KinDataStack(app, "KinDataStack", {
  env: { region: "us-east-1" },
});
