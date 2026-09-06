import { createLambdaHttpHandler } from "./lambda-http.js";
import { createConfiguredApp } from "./runtime.js";
import { fileURLToPath } from "node:url";

export const handler = createLambdaHttpHandler(
  createConfiguredApp(process.env, {
    requireOAuth: true,
    familyAssetDirectory: fileURLToPath(new URL("./family/", import.meta.url)),
  }),
);
