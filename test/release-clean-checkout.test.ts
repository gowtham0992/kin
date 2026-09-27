import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const root = process.cwd();

it("prepares an offline candidate from source without a cached assembly", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "kin-clean-release-test-"));
  let candidate: string | undefined;
  try {
    for (const name of ["src", "infra", "simulator", "widget", "scripts", "alexa",
      "package.json", "package-lock.json", "tsconfig.json", "cdk.json"]) {
      await cp(path.join(root, name), path.join(fixture, name), { recursive: true });
    }
    await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "dir");
    const { stdout } = await run(process.execPath, ["--import", "tsx", "scripts/prepare-release.ts"], {
      cwd: fixture,
      env: { PATH: process.env.PATH, GIT_DIR: path.join(root, ".git") },
      timeout: 18_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = JSON.parse(stdout);
    const report = JSON.parse(await readFile(output.reportFile, "utf8"));
    candidate = report.releaseDirectory;
    expect(report.status).toBe("local-candidate-not-deployed");
    expect(report.cached).toBeNull();
    expect(report.comparisons).toEqual([]);
    expect(output.cachedBaselineIssues).toContain("No cached cdk.out baseline exists; no baseline comparison or rollback verification was performed.");
    expect(report.candidate.stacks.map((stack: { name: string }) => stack.name)).toEqual(["KinDataStack", "KinApiStack"]);
    expect(report.voiceCandidate.stacks.map((stack: { name: string }) => stack.name)).toEqual(["KinEchoStack", "KinReminderSyncStack"]);

    // An existing but incomplete cache is corruption, not a fresh checkout.
    await mkdir(path.join(fixture, "cdk.out"));
    await expect(run(process.execPath, ["--import", "tsx", "scripts/prepare-release.ts"], {
      cwd: fixture, env: { PATH: process.env.PATH }, timeout: 5_000,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("manifest.json") });
  } finally {
    await rm(fixture, { recursive: true, force: true });
    if (candidate && path.dirname(candidate) === tmpdir() && path.basename(candidate).startsWith("kin-consolidated-release-")) {
      await rm(candidate, { recursive: true, force: true });
    }
  }
}, 25_000);
