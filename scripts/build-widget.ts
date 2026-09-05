import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildWidgetHtml(): Promise<string> {
  const template = await readFile(path.join(root, "widget/today.html"), "utf8");
  const moduleScript = /<script type="module">([\s\S]*?)<\/script>/;
  const source = moduleScript.exec(template)?.[1];
  if (!source) throw new Error("Widget entry script is missing");
  const result = await build({
    stdin: { contents: source, resolveDir: root, sourcefile: "widget/today.js" },
    bundle: true, write: false, format: "esm", platform: "browser",
    target: "es2022", charset: "utf8", minify: true, legalComments: "none", metafile: true,
  });
  if (Object.values(result.metafile!.outputs).some(output => output.imports.some(entry => entry.external))) {
    throw new Error("Widget must not depend on external imports");
  }
  const code = result.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");
  return template.replace(moduleScript, () => `<script type="module">${code}</script>`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = path.resolve(process.argv[2] ?? path.join(root, "dist/widget/today.html"));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, await buildWidgetHtml());
  console.log("Built self-contained Kin widget");
}
