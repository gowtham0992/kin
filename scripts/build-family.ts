import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { familyAssets } from "../src/family-assets.js";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(process.argv[2] ?? path.join(root, "dist/family"));
await mkdir(destination, { recursive: true });
for (const asset of familyAssets) {
  if (asset === "mcp-client.js") {
    await build({ absWorkingDir: root, entryPoints: ["simulator/mcp-client.ts"], outfile: path.join(destination, asset),
      bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "none" });
  } else {
    await copyFile(path.join(root, "simulator", asset), path.join(destination, asset));
  }
}
console.log("Packaged Kin family workspace assets");
