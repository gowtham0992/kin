import { defineConfig } from "vitest/config";

// These fixtures invoke CDK/esbuild or whole-release packaging. Running several
// alongside HTTP journeys oversubscribes the host and makes build deadlines
// measure contention rather than the operation. Keep every test and budget;
// serialize only artifact builders after the application group has finished.
export const artifactTestFiles = [
  "test/browser-oauth-provider.test.ts",
  "test/desktop-oauth-infra.test.ts",
  "test/echo-infra.test.ts",
  "test/escalation-monitoring-infra.test.ts",
  "test/family-bundle.test.ts",
  "test/infra.test.ts",
  "test/operations-routing.test.ts",
  "test/release-clean-checkout.test.ts",
  "test/reminder-rollout.test.ts",
  "test/reminder-sync-infra.test.ts",
];

export const kinTestOptions = {
  maxWorkers: 4,
  projects: [
    {
      test: {
        name: "application",
        include: ["test/**/*.test.ts"],
        exclude: artifactTestFiles,
        sequence: { groupOrder: 0 },
      },
    },
    {
      test: {
        name: "artifacts",
        include: artifactTestFiles,
        fileParallelism: false,
        sequence: { groupOrder: 1 },
      },
    },
  ],
};

export default defineConfig({ test: kinTestOptions });
