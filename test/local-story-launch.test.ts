import { describe, expect, it } from "vitest";
import { localStoryLaunch } from "../src/local-story-launch.js";

describe("explicit story launch policy", () => {
  it("ignores cloud and model environment in the default local mode", () => {
    expect(localStoryLaunch([], { AWS_PROFILE: "unrelated", AWS_REGION: "another-region", KIN_DEMO_CONVERSATION_MODEL_ID: "some-model" }))
      .toEqual({ help: false, port: 3030, model: null });
  });
  it("makes optional model use explicit, bounded to the chosen profile and region", () => {
    expect(localStoryLaunch(["--bedrock"], { AWS_PROFILE: "synthetic-kin", PORT: "3038" }))
      .toEqual({ help: false, port: 3038, model: { profile: "synthetic-kin", region: "us-east-1", modelId: "amazon.nova-micro-v1:0", timeoutMs: 5000 } });
  });
  it.each([{}, { AWS_PROFILE: "" }, { AWS_PROFILE: " kin " }, { AWS_PROFILE: "kin\n" },
    { AWS_PROFILE: "kin", AWS_REGION: "us-west-2" }, { AWS_PROFILE: "kin", AWS_ACCESS_KEY_ID: "synthetic" },
    { AWS_PROFILE: "kin", AWS_SESSION_TOKEN: "synthetic" }, { AWS_PROFILE: "kin", AWS_SECRET_ACCESS_KEY: "synthetic" },
    { AWS_PROFILE: "kin", AWS_BEARER_TOKEN_BEDROCK: "synthetic" }, { AWS_PROFILE: "kin", AWS_BEARER_TOKEN_BEDROCK: "" },
    { AWS_PROFILE: "kin", AWS_ACCESS_KEY_ID: "" }])(
    "refuses ambiguous or unsupported cloud configuration %j", environment => {
      expect(() => localStoryLaunch(["--bedrock"], environment)).toThrow();
    });
  it.each(["0", "3000.5", "65536", "80", " 3030", "3030 ", ""]) ("rejects unsafe port %s", PORT => {
    expect(() => localStoryLaunch([], { PORT })).toThrow("PORT");
  });
  it.each([{ args: ["--cloud"] }, { args: ["--bedrock", "--bedrock"] }, { args: ["--help", "--bedrock"] }])(
    "rejects unsupported options $args", ({ args }) => { expect(() => localStoryLaunch(args, {})).toThrow("Supported story option"); });
  it("offers help without requiring credentials or starting the server", () => {
    expect(localStoryLaunch(["--help"], {})).toEqual({ help: true });
  });
});
