import { describe, expect, it } from "vitest";
import { releaseCodePatch } from "../src/release-code-patch.js";

const hash = "a".repeat(64);
const release = { component: "api", sha256: hash, versionId: "version-one" } as const;
const template = { Parameters: { Enabled: { Default: "false" } }, Resources: {
  Api: { Type: "AWS::Lambda::Function", Properties: { FunctionName: "kin-mcp-api", Code: { S3Key: "old.zip" }, Environment: { Variables: { KIN_CLOSE_UNANSWERED_ENABLED: "false" } } } },
  Schedule: { Type: "AWS::Scheduler::Schedule", Properties: { State: "DISABLED" } },
} };

describe("version-pinned code-only release patch", () => {
  it("preserves every setting, reader gate and unrelated resource without mutating the baseline", () => {
    const before = structuredClone(template);
    const patched = releaseCodePatch(template, release);
    expect(template).toEqual(before);
    expect(patched.Resources.Api.Properties.Code).toEqual({ S3Bucket: "cdk-hnb659fds-assets-954807518512-us-east-1", S3Key: `kin-releases/api/${hash}.zip`, S3ObjectVersion: "version-one" });
    patched.Resources.Api.Properties.Code = before.Resources.Api.Properties.Code;
    expect(patched).toEqual(before);
  });
  it.each(["", "null", " ", "x\n"])("rejects an unpinned or malformed S3 version %j", versionId => {
    expect(() => releaseCodePatch(template, { ...release, versionId })).toThrow();
  });
  it("rejects unsupported components, malformed digests, and ambiguous function identities", () => {
    expect(() => releaseCodePatch(template, { ...release, component: "oauth" } as never)).toThrow();
    expect(() => releaseCodePatch(template, { ...release, sha256: "../other" })).toThrow();
    expect(() => releaseCodePatch({ Resources: {} }, release)).toThrow();
    expect(() => releaseCodePatch({ Resources: { ...template.Resources, Duplicate: template.Resources.Api } }, release)).toThrow();
  });
});
