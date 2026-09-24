// Local fresh-process comparison only. No AWS credentials, requests or writes.
import { build } from 'esbuild';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'kin-api-startup-'));
await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
for (const mode of ['external', 'bundled']) {
  await build({ entryPoints: [path.join(root, 'src/lambda.ts')], bundle: true,
    platform: 'node', target: 'node22', format: 'esm', minify: true,
    sourcemap: true, sourcesContent: false,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    external: mode === 'external' ? ['@aws-sdk/*'] : [],
    outfile: path.join(directory, `${mode}.mjs`) });
}
const environment = { PATH: process.env.PATH, AWS_REGION: 'us-east-1',
  AWS_EC2_METADATA_DISABLED: 'true', KIN_PUBLIC_API_ENABLED: 'true',
  KIN_OAUTH_ISSUER: 'https://kin.example', KIN_OAUTH_JWKS_URI: 'https://kin.example/jwks',
  KIN_MCP_CANONICAL_URI: 'https://kin.example/mcp', KIN_DYNAMODB_TABLE: 'synthetic-only' };
const results = { external: [], bundled: [] };
for (let round = 0; round < 9; round++) {
  for (const mode of round % 2 ? ['bundled', 'external'] : ['external', 'bundled']) {
    const url = pathToFileURL(path.join(directory, `${mode}.mjs`)).href;
    const script = `const start=performance.now(); const m=await import(${JSON.stringify(url)}); if(typeof m.handler!=='function') throw Error('Missing handler'); console.log(performance.now()-start);`;
    const elapsed = Number(execFileSync(process.execPath, ['--enable-source-maps', '--input-type=module', '-e', script],
      { env: environment, encoding: 'utf8', timeout: 15000 }));
    if (!Number.isFinite(elapsed)) throw Error('Invalid measurement');
    results[mode].push(elapsed);
  }
}
console.log(JSON.stringify({ node: process.version, directory,
  scope: 'Local fresh-process imports, not Lambda or physical voice latency',
  results, medians: Object.fromEntries(Object.entries(results).map(([mode, values]) =>
    [mode, [...values].sort((a, b) => a - b)[4]])) }, null, 2));
