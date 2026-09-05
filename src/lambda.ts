import { createLambdaHttpHandler } from "./lambda-http.js";
import { createConfiguredApp } from "./runtime.js";

export const handler = createLambdaHttpHandler(
  createConfiguredApp(process.env, { requireOAuth: true }),
);
