import { createDemoStore } from "./domain.js";
import { createJwtAccessAuthorizer } from "./auth.js";
import { createDynamoCareRepository } from "./dynamo-care-repository.js";
import { createHttpApp } from "./http.js";
import {
  createBedrockBriefGenerator,
  WeeklyBriefService,
} from "./weekly-brief.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const tableName = process.env.KIN_DYNAMODB_TABLE?.trim();
const circleId = process.env.KIN_CIRCLE_ID?.trim() || "demo-family";
const timeZone = process.env.KIN_TIME_ZONE?.trim() || "UTC";
const repository = tableName
  ? createDynamoCareRepository({
      tableName,
      circleId,
      region: process.env.AWS_REGION,
      timeZone,
    })
  : createDemoStore(() => new Date(), timeZone);
const briefModelId = process.env.KIN_BEDROCK_MODEL_ID?.trim();
const briefTimeoutMs = Number.parseInt(process.env.KIN_BEDROCK_TIMEOUT_MS ?? "300", 10);
const weeklyBrief = new WeeklyBriefService(
  repository,
  briefModelId
    ? createBedrockBriefGenerator({
        modelId: briefModelId,
        region: process.env.AWS_REGION,
        timeoutMs: briefTimeoutMs,
      })
    : null,
  timeZone,
);

const canonicalMcpUri = process.env.KIN_MCP_CANONICAL_URI?.trim();
const oauthIssuer = process.env.KIN_OAUTH_ISSUER?.trim();
const oauthJwksUri = process.env.KIN_OAUTH_JWKS_URI?.trim();
const oauthAuthorizationServer = process.env.KIN_OAUTH_AUTHORIZATION_SERVER?.trim() || oauthIssuer;
const oauthValues = [canonicalMcpUri, oauthIssuer, oauthJwksUri];
if (oauthValues.some(Boolean) && !oauthValues.every(Boolean)) {
  throw new Error(
    "KIN_MCP_CANONICAL_URI, KIN_OAUTH_ISSUER, and KIN_OAUTH_JWKS_URI must be configured together",
  );
}

const app = createHttpApp(repository, weeklyBrief, canonicalMcpUri && oauthIssuer && oauthJwksUri
  ? {
      accessAuthorizer: createJwtAccessAuthorizer({
        issuer: oauthIssuer,
        audience: canonicalMcpUri,
        jwksUri: oauthJwksUri,
      }),
      canonicalMcpUri,
      authorizationServer: oauthAuthorizationServer,
      serveSimulator: process.env.KIN_SERVE_SIMULATOR === "true",
    }
  : {});
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Kin MCP server listening at http://127.0.0.1:${port}/mcp`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
