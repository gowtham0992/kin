import { configure as serverlessExpress } from "@codegenie/serverless-express";
import type { Handler } from "aws-lambda";
import express, { type NextFunction, type Request, type Response } from "express";
import { CognitoAccountAuthenticator } from "./cognito-authenticator.js";
import { createDynamoOidcAdapter } from "./oauth-dynamo-adapter.js";
import { createOAuthInteractionRouter } from "./oauth-interactions.js";
import type { AccountAuthenticator } from "./oauth-interactions.js";
import { createKinOAuthProvider } from "./oauth-provider.js";
import { loadOAuthSecrets, type OAuthSecrets } from "./oauth-secrets.js";
import { createUnavailablePublicApp } from "./public-api-gate.js";

interface OAuthRuntimeDependencies {
  loadSecrets?: typeof loadOAuthSecrets;
  secrets?: OAuthSecrets;
  adapter?: new (model: string) => object;
  authenticator?: AccountAuthenticator;
}

export async function createConfiguredOAuthApp(
  environment: NodeJS.ProcessEnv,
  dependencies: OAuthRuntimeDependencies = {},
) {
  if (environment.KIN_PUBLIC_API_ENABLED === "false") return createUnavailablePublicApp();
  const issuer = requiredHttpsUrl(environment.KIN_OAUTH_ISSUER, "KIN_OAUTH_ISSUER");
  const resourceUri = requiredHttpsUrl(environment.KIN_MCP_RESOURCE_URI, "KIN_MCP_RESOURCE_URI");
  const tableName = required(environment.KIN_OAUTH_STATE_TABLE, "KIN_OAUTH_STATE_TABLE");
  const cognitoClientId = required(environment.KIN_COGNITO_CLIENT_ID, "KIN_COGNITO_CLIENT_ID");
  const secretId = required(environment.KIN_OAUTH_SECRET_ID, "KIN_OAUTH_SECRET_ID");
  const secrets = dependencies.secrets ?? await (dependencies.loadSecrets ?? loadOAuthSecrets)({
    secretId,
    region: environment.AWS_REGION,
  });
  const redirectUris = (environment.KIN_ALEXA_REDIRECT_URIS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const provider = createKinOAuthProvider({
    issuer,
    resourceUri,
    jwks: secrets.jwks,
    cookieKeys: secrets.cookieKeys,
    adapter: dependencies.adapter ?? createDynamoOidcAdapter({
      tableName,
      region: environment.AWS_REGION,
    }),
    serviceClient: secrets.serviceClient,
    ...(redirectUris.length === 0 ? {} : {
      userClient: { ...secrets.userClient, redirectUris },
    }),
    findAccount: async (accountId) => ({
      accountId,
      claims: async () => ({ sub: accountId }),
    }),
  });
  const app = express();
  app.disable("x-powered-by");
  app.use(createOAuthInteractionRouter({
    provider,
    authenticator: dependencies.authenticator ?? new CognitoAccountAuthenticator({
      clientId: cognitoClientId,
      region: environment.AWS_REGION,
    }),
    resourceUri,
    csrfSecret: secrets.csrfSecret,
  }));
  const providerCallback = provider.callback();
  app.use((request, response) => providerCallback(request, response));
  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) return;
    response.setHeader("Cache-Control", "no-store");
    response.status(500).type("text").send("Kin couldn't complete account linking. Start again from Alexa+.");
  });
  return app;
}

let proxyHandler: Handler | undefined;

export const handler: Handler = async (event, context, callback) => {
  proxyHandler ??= serverlessExpress({ app: await createConfiguredOAuthApp(process.env) });
  return proxyHandler(event, context, callback);
};

function required(value: string | undefined, name: string) {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function requiredHttpsUrl(value: string | undefined, name: string) {
  const parsed = new URL(required(value, name));
  if (parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return parsed.toString().replace(/\/$/, "");
}
