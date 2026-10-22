import { readdir, readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("runs artifact-building tests alone after application tests without relaxing their budgets", async () => {
  const { kinTestOptions } = await import("../vitest.config.js");
  expect(kinTestOptions.projects).toHaveLength(2);
  const application = kinTestOptions.projects[0]!;
  const artifacts = kinTestOptions.projects[1]!;
  expect(kinTestOptions.maxWorkers).toBe(4);
  expect(application.test.name).toBe("application");
  expect(application.test.include).toEqual(["test/**/*.test.ts"]);
  expect(application.test.sequence.groupOrder).toBe(0);
  expect(artifacts.test.sequence.groupOrder).toBe(1);
  expect(artifacts.test.fileParallelism).toBe(false);
  expect(application.test.exclude).toEqual(artifacts.test.include);
  for (const project of kinTestOptions.projects) {
    expect(project.test).not.toHaveProperty("retry");
    expect(project.test).not.toHaveProperty("testTimeout");
  }
});

it("assigns every infrastructure-builder fixture to the serialized artifact project", async () => {
  const { artifactTestFiles } = await import("../vitest.config.js");
  const builders: string[] = [];
  for (const name of await readdir(new URL(".", import.meta.url))) {
    if (!name.endsWith(".test.ts")) continue;
    const text = await readFile(new URL(name, import.meta.url), "utf8");
    if (/from ["']aws-cdk-lib(?:\/[\w-]+)?["']/.test(text) || name === "release-clean-checkout.test.ts") {
      builders.push(`test/${name}`);
    }
  }
  expect([...artifactTestFiles].sort()).toEqual(builders.sort());
  expect(new Set(artifactTestFiles).size).toBe(artifactTestFiles.length);
});
