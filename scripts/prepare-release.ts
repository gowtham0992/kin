import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, lstat, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { ANALYTICS_REPORTING_ENABLED_CONTEXT, ASSET_RESOURCE_METADATA_ENABLED_CONTEXT, PATH_METADATA_ENABLE_CONTEXT } from "aws-cdk-lib/cx-api";
import { KinApiStack } from "../infra/kin-api-stack.js";
import { KinDataStack } from "../infra/kin-data-stack.js";
import { KinEchoStack } from "../infra/kin-echo-stack.js";
import { KinReminderSyncStack } from "../infra/kin-reminder-sync-stack.js";
import { familyAssets } from "../src/family-assets.js";
import { assertPausedReleaseDefaults } from "../src/release-defaults.js";
import { build } from "esbuild";

// Local artifact preparation only. This script has no publishing or deployment path.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stackNames = ["KinDataStack", "KinApiStack"] as const;
const voiceStackNames = ["KinEchoStack", "KinReminderSyncStack"] as const;
const sourceDirectories = ["src", "infra", "simulator", "widget", "scripts", "alexa"];
const sourceFiles = ["package.json", "package-lock.json", "tsconfig.json", "cdk.json"];
// Installed CLI defaults (aws-cdk/lib/index.js determineContext/buildDefaultSettings).
// These restore synthesis metadata only; cdk.json remains the application context.
const synthesisMetadataContext = {
  [PATH_METADATA_ENABLE_CONTEXT]: true,
  [ASSET_RESOURCE_METADATA_ENABLED_CONTEXT]: true,
  [ANALYTICS_REPORTING_ENABLED_CONTEXT]: true,
};
const require = createRequire(import.meta.url);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type FileHash = { path: string; sha256: string };
type Manifest = {
  version: string; missing?: unknown[];
  artifacts: Record<string, { type: string; environment?: string; properties?: Record<string, unknown>; dependencies?: string[] }>;
};
type Template = { Resources: Record<string, { Type: string; Properties?: Record<string, unknown>; Metadata?: Record<string, unknown> }>; [key: string]: unknown };
type Assets = { files: Record<string, { displayName?: string; source: { path: string; packaging: string } }> };

function inside(directory: string, file: string) {
  const relative = path.relative(directory, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function changedPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (canonical(before) === canonical(after)) return [];
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
      .flatMap(key => changedPaths(left[key], right[key], `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`));
  }
  return [prefix || "/"];
}
async function hashTree(directory: string, prefix = ""): Promise<FileHash[]> {
  const rows: FileHash[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const location = path.join(directory, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Refusing a symlink in release inputs: ${relative}`);
    if (entry.isDirectory()) rows.push(...await hashTree(location, relative));
    else if (entry.isFile()) rows.push({ path: relative, sha256: sha256(await readFile(location)) });
    else throw new Error(`Unsupported release input: ${relative}`);
  }
  return rows;
}
async function inputHashes() {
  const files = (await Promise.all(sourceDirectories.map(directory => hashTree(path.join(root, directory), directory)))).flat();
  for (const file of sourceFiles) files.push({ path: file, sha256: sha256(await readFile(path.join(root, file))) });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { sha256: sha256(canonical(files)), files };
}
async function json<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }
async function containedBytes(directory: string, relative: string) {
  const location = path.resolve(directory, relative);
  if (!inside(directory, location) || (await lstat(location)).isSymbolicLink() ||
      !inside(await realpath(directory), await realpath(location))) throw new Error("Unsafe assembly metadata path");
  return readFile(location);
}
async function assemblySnapshot(directory: string, strict: boolean, names: readonly string[] = stackNames) {
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Refusing a symlinked assembly directory");
  const manifestBytes = await containedBytes(directory, "manifest.json");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  if (manifest.missing?.length) throw new Error("Assembly requires unresolved context lookups; offline preparation cannot resolve them");
  const stackArtifacts = Object.keys(manifest.artifacts).filter(id => manifest.artifacts[id]?.type === "aws:cloudformation:stack").sort();
  if (canonical(stackArtifacts) !== canonical([...names].sort())) throw new Error(`Expected exactly ${names.join(" and ")}`);
  const issues: string[] = [];
  const stacks = [];
  for (const name of names) {
    const artifact = manifest.artifacts[name]!;
    if (strict && artifact.environment !== "aws://unknown-account/us-east-1") throw new Error(`Unexpected environment for ${name}`);
    const templateFile = artifact.properties?.templateFile;
    if (typeof templateFile !== "string" || !inside(directory, path.resolve(directory, templateFile))) throw new Error("Unsafe template path");
    const templateBytes = await containedBytes(directory, templateFile);
    const template = JSON.parse(templateBytes.toString("utf8")) as Template;
    const assetManifestFile = manifest.artifacts[`${name}.assets`]?.properties?.file;
    if (typeof assetManifestFile !== "string" || !inside(directory, path.resolve(directory, assetManifestFile))) throw new Error("Unsafe asset manifest path");
    const assetManifestBytes = await containedBytes(directory, assetManifestFile);
    const assets = JSON.parse(assetManifestBytes.toString("utf8")) as Assets;
    const inventory = [];
    for (const [id, asset] of Object.entries(assets.files)) {
      const location = path.resolve(directory, asset.source.path);
      let files: FileHash[] = [];
      let issue: string | undefined;
      if (!inside(directory, location)) issue = `${name} asset ${id} points outside its assembly; not a self-contained publishable or rollback asset`;
      else {
        try {
          if (!inside(await realpath(directory), await realpath(location)) || (await lstat(location)).isSymbolicLink()) throw new Error("Asset escapes its assembly");
          files = asset.source.packaging === "zip" ? await hashTree(location)
            : [{ path: path.basename(location), sha256: sha256(await readFile(location)) }];
          if (!files.length) throw new Error("Asset has no files");
        } catch { issue = `${name} asset ${id} is missing, empty, or not safely contained in its assembly`; }
      }
      if (issue) { if (strict) throw new Error(issue); issues.push(issue); }
      inventory.push({ id, displayName: asset.displayName, source: asset.source, files,
        ...(issue ? { issue } : { contentSha256: sha256(canonical(files)) }) });
    }
    if (strict) {
      const functions: Record<string, string[]> = { KinDataStack: ["kin-escalation-worker"],
        KinApiStack: ["kin-mcp-api", "kin-oauth-api", "kin-oauth-secret-provisioner"],
        KinEchoStack: ["kin-echo-development"], KinReminderSyncStack: ["kin-reminder-sync-worker"] };
      const expected = functions[name];
      if (!expected) throw new Error(`Unknown stack ${name}`);
      for (const functionName of expected) {
        const resource = Object.values(template.Resources).find(item => item.Type === "AWS::Lambda::Function" && item.Properties?.FunctionName === functionName);
        const key = (resource?.Properties?.Code as { S3Key?: unknown } | undefined)?.S3Key;
        const asset = typeof key === "string" ? inventory.find(item => `${item.id}.zip` === key) : undefined;
        if (!asset?.files.some(file => /^index\.(?:mjs|js)$/.test(file.path))) throw new Error(`Missing staged handler for ${functionName}`);
      }
    }
    stacks.push({ name, artifact, template, templateSha256: sha256(templateBytes),
      assetManifestSha256: sha256(assetManifestBytes), assets: inventory });
  }
  return { directory, manifestSha256: sha256(manifestBytes), manifest, stacks, issues };
}

async function main() {
  if (process.argv.length > 2) throw new Error("This offline preparer takes no arguments");
  // CDK CLI-injected context can silently skip bundling or disable asset staging.
  for (const name of ["CDK_CONTEXT_JSON", "CDK_CONTEXT_OVERFLOW_LOCATION", "CDK_BUNDLING_STACKS"]) {
    if (process.env[name]) throw new Error(`Run outside the CDK CLI; ${name} must be unset`);
  }
  // Require installed local tooling. CDK must not fall back to pulling a Docker image.
  await access(path.join(root, "node_modules/.bin/esbuild"));
  require.resolve("esbuild"); require.resolve("tsx");
  process.env.npm_config_offline = "true";
  process.env.npm_config_yes = "false";
  const config = await json<{ context: Record<string, unknown> }>(path.join(root, "cdk.json"));
  if (!config.context || typeof config.context !== "object" || Array.isArray(config.context)) throw new Error("Missing CDK context");
  const before = await inputHashes();
  const cached = await assemblySnapshot(path.join(root, "cdk.out"), false);
  const releaseDirectory = await mkdtemp(path.join(tmpdir(), "kin-consolidated-release-"));
  const outdir = path.join(releaseDirectory, "cdk.out");
  console.error(`Preparing local candidate in ${releaseDirectory}; cached cdk.out remains untouched.`);
  // Keep these definitions identical to infra/app.ts. No account lookup or CLI is involved.
  const app = new App({ autoSynth: false, outdir, context: { ...synthesisMetadataContext, ...config.context } });
  new KinDataStack(app, "KinDataStack", { env: { region: "us-east-1" } });
  new KinApiStack(app, "KinApiStack", { env: { region: "us-east-1" }, terminationProtection: true });
  app.synth();
  const current = await assemblySnapshot(outdir, true);
  // Separate assemblies preserve the independent deployment boundaries. Preparation never deploys either.
  const voiceOutdir = path.join(releaseDirectory, "voice-cdk.out");
  const voiceApp = new App({ autoSynth: false, outdir: voiceOutdir, context: { ...synthesisMetadataContext, ...config.context } });
  new KinEchoStack(voiceApp, "KinEchoStack", { env: { region: "us-east-1" }, terminationProtection: true });
  new KinReminderSyncStack(voiceApp, "KinReminderSyncStack", { env: { region: "us-east-1" }, terminationProtection: true,
    careTableName: "kin-care-state", circleId: "demo-family" });
  voiceApp.synth();
  const voice = await assemblySnapshot(voiceOutdir, true, voiceStackNames);
  assertPausedReleaseDefaults([...current.stacks, ...voice.stacks]);
  const api = current.stacks.find(stack => stack.name === "KinApiStack")!;
  const apiResource = Object.values(api.template.Resources).find(item => item.Type === "AWS::Lambda::Function" && item.Properties?.FunctionName === "kin-mcp-api")!;
  const key = (apiResource.Properties!.Code as { S3Key: string }).S3Key.replace(/\.zip$/, "");
  const apiAsset = api.assets.find(asset => asset.id === key)!;
  const packaged = apiAsset.files.filter(file => file.path.startsWith("family/")).map(file => file.path.slice("family/".length)).sort();
  if (canonical(packaged) !== canonical([...familyAssets].sort())) throw new Error("Family package differs from the exact production allowlist");
  const compiledMcp = await build({ absWorkingDir: root, entryPoints: ["simulator/mcp-client.ts"], bundle: true,
    format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "none", write: false });
  for (const asset of familyAssets) {
    const source = asset === "mcp-client.js" ? Buffer.from(compiledMcp.outputFiles[0]!.contents) : await readFile(path.join(root, "simulator", asset));
    if (apiAsset.files.find(file => file.path === `family/${asset}`)?.sha256 !== sha256(source)) {
      throw new Error(`Packaged family asset does not match source: ${asset}`);
    }
  }
  if (!apiAsset.files.some(file => file.path === "widget/today.html")) throw new Error("Packaged widget is missing");
  if (apiAsset.files.some(file => /(^|\/)(?:story\.(?:html|css|js)|local-story\.[^/]+|simulator|\.env)(?:\/|$)/.test(file.path))) {
    throw new Error("Demo or environment files leaked into the API asset");
  }
  const after = await inputHashes();
  if (before.sha256 !== after.sha256) throw new Error(`Source changed during synthesis; candidate at ${releaseDirectory} is not releasable`);
  const comparisons = current.stacks.map(stack => {
    const prior = cached.stacks.find(item => item.name === stack.name)!;
    const paths = changedPaths(prior.template, stack.template);
    const knownFunctions = new Set(Object.entries(stack.template.Resources).filter(([, item]) => item.Type === "AWS::Lambda::Function" &&
      ["kin-mcp-api", "kin-oauth-api", "kin-escalation-worker"].includes(String(item.Properties?.FunctionName))).map(([id]) => id));
    const codeOnlyPath = (item: string) => {
      const match = /^\/Resources\/([^/]+)\/(?:Properties\/Code\/S3Key|Metadata\/aws:asset:path)$/.exec(item);
      return !!match && knownFunctions.has(match[1]!);
    };
    return { stack: stack.name, cachedTemplateSha256: prior.templateSha256, candidateTemplateSha256: stack.templateSha256,
      changedTemplatePaths: paths, nonCodeChangesRequiringReview: paths.filter(item => !codeOnlyPath(item)),
      changedManifestArtifactPaths: changedPaths(prior.artifact, stack.artifact) };
  });
  const report = {
    status: "local-candidate-not-deployed", createdAt: new Date().toISOString(),
    comparisonScope: "Cached local cdk.out only; not the live AWS template, parameters, IAM, drift, alarms or delivery state",
    releaseDirectory, assemblyDirectory: outdir,
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    runtime: { node: process.version, cdk: require("aws-cdk-lib/package.json").version, esbuild: require("esbuild/package.json").version },
    configContext: config.context, synthesisMetadataContext, sourceInputs: before,
    cached: { directory: cached.directory, manifestSha256: cached.manifestSha256, issues: cached.issues,
      stacks: cached.stacks.map(({ template: _template, ...stack }) => stack) },
    candidate: { manifestSha256: current.manifestSha256, manifest: current.manifest,
      stacks: current.stacks.map(({ template: _template, ...stack }) => stack) },
    voiceCandidate: { directory: voiceOutdir, manifestSha256: voice.manifestSha256, manifest: voice.manifest,
      stacks: voice.stacks.map(({ template: _template, ...stack }) => stack),
      comparisonScope: "No live or cached Echo/reminder-sync baseline is compared; no deployment or activation is authorized." },
    packagedFamilyAssets: packaged, comparisons,
    limitations: [
      "No deployment approval, artifact publication, change set, AWS credentials, live account or external notification was used.",
      "Source hashes do not prove tests passed. Complete the build, regression and candidate-artifact checks before promotion.",
      "PublicApiEnabled does not stop the escalation worker. Worker promotion requires a separately approved and verified stop/rollback gate.",
      "Cached artifacts may not be a usable worker rollback. Preserve the actual previous worker artifact and state-compatible recovery plan before release.",
      "Temporary candidate files are not a durable backup. Preserve the reviewed assembly without resynthesis before any approved promotion.",
      "Echo/reminder-sync templates and the hashed Alexa interaction model require their own reviewed live baselines, exact permissions and device acceptance.",
    ],
  };
  const reportFile = path.join(releaseDirectory, "release-report.json");
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ status: report.status, reportFile, assemblyDirectory: outdir, sourceSha256: before.sha256,
    voiceAssemblyDirectory: voiceOutdir,
    cachedBaselineIssues: cached.issues, comparisons }, null, 2));
}

await main();
