import { build } from "esbuild";

await build({
  entryPoints: ["simulator/mcp-client.ts"], outfile: "dist/simulator/mcp-client.js",
  bundle: true, format: "esm", platform: "browser", target: "es2022",
  minify: true, legalComments: "none",
});
