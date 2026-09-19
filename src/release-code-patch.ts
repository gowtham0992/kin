const targets = { api: "kin-mcp-api", escalation: "kin-escalation-worker", echo: "kin-echo-development" } as const;
type Template = { Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> };

/** Pure, code-only patch against a fresh live template; does not publish or deploy. */
export function releaseCodePatch<T extends Template>(baseline: T, release: {
  component: keyof typeof targets; sha256: string; versionId: string;
}): T {
  if (!Object.hasOwn(targets, release.component) || !/^[a-f0-9]{64}$/.test(release.sha256) ||
      !/^[\x21-\x7e]{1,1024}$/.test(release.versionId) || release.versionId === "null") {
    throw new Error("An allowlisted component, SHA-256 and non-null S3 version are required");
  }
  const matches = Object.entries(baseline.Resources).filter(([, resource]) =>
    resource.Type === "AWS::Lambda::Function" && resource.Properties?.FunctionName === targets[release.component]);
  if (matches.length !== 1) throw new Error("Expected exactly one matching Lambda resource");
  const patched = structuredClone(baseline);
  patched.Resources[matches[0]![0]]!.Properties!.Code = {
    S3Bucket: "cdk-hnb659fds-assets-954807518512-us-east-1",
    S3Key: `kin-releases/${release.component}/${release.sha256}.zip`,
    S3ObjectVersion: release.versionId,
  };
  return patched;
}
