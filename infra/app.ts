import { App } from "aws-cdk-lib";
import { KinDataStack } from "./kin-data-stack.js";
import { KinApiStack } from "./kin-api-stack.js";

const app = new App();
new KinDataStack(app, "KinDataStack", {
  env: { region: "us-east-1" },
});
new KinApiStack(app, "KinApiStack", {
  env: { region: "us-east-1" },
});
