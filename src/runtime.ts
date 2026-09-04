import { createJwtAccessAuthorizer } from "./auth.js";
import { createDemoStore } from "./domain.js";
import { createDynamoCareRepository } from "./dynamo-care-repository.js";
import { createHttpApp } from "./http.js";
import { createBedrockBriefGenerator, WeeklyBriefService } from "./weekly-brief.js";

export interface RuntimeOptions {
  requireOAuth?: boolean;
}

export function createConfiguredApp(
  environment: NodeJS.ProcessEnv = process.env,
  options: RuntimeOptions = {},
) {
  const tableName = environment.KIN_DYNAMODB_TABLE?.trim();
  const circleId = environment.KIN_CIRCLE_ID?.trim() || "demo-family";
  const timeZone = environment.KIN_TIME_ZONE?.trim() || "UTC";
  const repository = tableName
    ? createDynamoCareRepository({
        tableName,
        circleId,
        region: environment.AWS_REGION,
        timeZone,
      })
    : createDemoStore(() => new Date(), timeZone);
  const briefModelId = environment.KIN_BEDROCK_MODEL_ID?.trim();
  const briefTimeoutMs = Number.parseInt(environment.KIN_BEDROCK_TIMEOUT_MS ?? "300", 10);
  const weeklyBrief = new WeeklyBriefService(
    repository,
    briefModelId
      ? createBedrockBriefGenerator({
          modelId: briefModelId,
          region: environment.AWS_REGION,
          timeoutMs: briefTimeoutMs,
        })
      : null,
    timeZone,
  );

  const canonicalMcpUri = environment.KIN_MCP_CANONICAL_URI?.trim();
  const oauthIssuer = environment.KIN_OAUTH_ISSUER?.trim();
  const oauthJwksUri = environment.KIN_OAUTH_JWKS_URI?.trim();
  const oauthAuthorizationServer =
    environment.KIN_OAUTH_AUTHORIZATION_SERVER?.trim() || oauthIssuer;
  const oauthValues = [canonicalMcpUri, oauthIssuer, oauthJwksUri];
  if (oauthValues.some(Boolean) && !oauthValues.every(Boolean)) {
    throw new Error(
      "KIN_MCP_CANONICAL_URI, KIN_OAUTH_ISSUER, and KIN_OAUTH_JWKS_URI must be configured together",
    );
  }
  if (options.requireOAuth && !oauthValues.every(Boolean)) {
    throw new Error("OAuth configuration is required on the public Kin runtime");
  }

  return createHttpApp(
    repository,
    weeklyBrief,
    canonicalMcpUri && oauthIssuer && oauthJwksUri
      ? {
          accessAuthorizer: createJwtAccessAuthorizer({
            issuer: oauthIssuer,
            audience: canonicalMcpUri,
            jwksUri: oauthJwksUri,
          }),
          canonicalMcpUri,
          authorizationServer: oauthAuthorizationServer,
          serveSimulator: environment.KIN_SERVE_SIMULATOR === "true",
        }
      : {},
  );
}
