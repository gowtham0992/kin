import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import { KinApiStack } from "../infra/kin-api-stack.js";

it("keeps independent desktop registration opt-in and confined to the OAuth runtime", () => {
  const template = Template.fromStack(new KinApiStack(new App(), "DesktopOAuthTest", {
    env: { account: "123456789012", region: "us-east-1" },
  }));
  template.hasParameter("DesktopAuthEnabled", { Type: "String", Default: "false", AllowedValues: ["true", "false"] });
  const functions = Object.values(template.findResources("AWS::Lambda::Function"));
  const withDesktop = functions.filter(fn => fn.Properties.Environment?.Variables?.KIN_DESKTOP_AUTH_ENABLED !== undefined);
  expect(withDesktop).toHaveLength(1);
  expect(withDesktop[0]!.Properties).toMatchObject({ FunctionName: "kin-oauth-api", Environment: { Variables: {
    KIN_DESKTOP_AUTH_ENABLED: { Ref: "DesktopAuthEnabled" }, KIN_BROWSER_CLIENT_ID: "kin-family-browser",
  } } });
}, 30_000);
