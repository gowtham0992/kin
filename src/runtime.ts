import { createJwtAccessAuthorizer } from "./auth.js";
import { createDynamoMembershipDirectory } from "./membership.js";
import { createCognitoInvitableAccounts, createDynamoInvitationIssuer } from "./invitation-issuer.js";
import { createDemoStore } from "./domain.js";
import { createDynamoCareRepository } from "./dynamo-care-repository.js";
import { createHttpApp } from "./http.js";
import { createStringParameterProvider } from "./parameter.js";
import { createUnavailablePublicApp } from "./public-api-gate.js";
import { createBedrockBriefGenerator, WeeklyBriefService } from "./weekly-brief.js";

export interface RuntimeOptions {
  requireOAuth?: boolean;
}

export function createConfiguredApp(
  environment: NodeJS.ProcessEnv = process.env,
  options: RuntimeOptions = {},
) {
  if (environment.KIN_PUBLIC_API_ENABLED === "false") return createUnavailablePublicApp();
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
  const canonicalMcpParameter = environment.KIN_MCP_RESOURCE_PARAMETER?.trim();
  if (canonicalMcpUri && canonicalMcpParameter) {
    throw new Error(
      "Configure either KIN_MCP_CANONICAL_URI or KIN_MCP_RESOURCE_PARAMETER, not both",
    );
  }
  const canonicalMcpResource = canonicalMcpUri || (canonicalMcpParameter
    ? createStringParameterProvider({
        parameterName: canonicalMcpParameter,
        region: environment.AWS_REGION,
      })
    : undefined);
  const oauthIssuer = environment.KIN_OAUTH_ISSUER?.trim();
  const oauthJwksUri = environment.KIN_OAUTH_JWKS_URI?.trim();
  const oauthAuthorizationServer =
    environment.KIN_OAUTH_AUTHORIZATION_SERVER?.trim() || oauthIssuer;
  const oauthValues = [canonicalMcpResource, oauthIssuer, oauthJwksUri];
  if (oauthValues.some(Boolean) && !oauthValues.every(Boolean)) {
    throw new Error(
      "KIN_MCP_CANONICAL_URI, KIN_OAUTH_ISSUER, and KIN_OAUTH_JWKS_URI must be configured together",
    );
  }
  if (options.requireOAuth && !oauthValues.every(Boolean)) {
    throw new Error("OAuth configuration is required on the public Kin runtime");
  }

  const familyAccess = tableName ? {
    circleId, directory: createDynamoMembershipDirectory({ tableName, circleId, region: environment.AWS_REGION }),
  } : undefined;
  const issuingEnabled = environment.KIN_INVITATION_ISSUING_ENABLED === "true";
  const userPoolId = environment.KIN_COGNITO_USER_POOL_ID?.trim();
  const circleName = environment.KIN_CIRCLE_NAME?.trim();
  if (issuingEnabled && (!familyAccess || !oauthValues.every(Boolean) || !userPoolId || !circleName)) {
    throw new Error("Invitation issuing requires OAuth, a care table, user pool, and circle name");
  }

  return createHttpApp(
    repository,
    weeklyBrief,
    canonicalMcpResource && oauthIssuer && oauthJwksUri
      ? {
          accessAuthorizer: createJwtAccessAuthorizer({
            issuer: oauthIssuer,
            audience: canonicalMcpResource,
            jwksUri: oauthJwksUri,
          }),
          familyAccess,
          invitationIssuer: issuingEnabled ? createDynamoInvitationIssuer({
            tableName: tableName!, familyAccess: familyAccess!, circleName: circleName!, issuer: oauthIssuer,
            accounts: createCognitoInvitableAccounts({ userPoolId: userPoolId!, region: environment.AWS_REGION }),
            region: environment.AWS_REGION,
          }) : undefined,
          canonicalMcpUri: canonicalMcpResource,
          authorizationServer: oauthAuthorizationServer,
          serveSimulator: environment.KIN_SERVE_SIMULATOR === "true",
        }
      : {},
  );
}
