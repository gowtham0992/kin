import { configure as serverlessExpress } from "@codegenie/serverless-express";
import { createConfiguredApp } from "./runtime.js";

export const handler = serverlessExpress({
  app: createConfiguredApp(process.env, { requireOAuth: true }),
});
