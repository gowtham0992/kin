import { createJwtAccessAuthorizer, parseMcpAuthMode } from "./auth.js";
import { createDynamoAccessManagement } from "./access-management.js";
import { createDynamoRosterManagement } from "./roster-management.js";
import { browserAuthConfig } from "./browser-auth-config.js";
import { createDynamoBrowserSessions } from "./browser-session.js";
import { createDynamoMembershipDirectory } from "./membership.js";
import { createCognitoInvitableAccounts, createDynamoInvitationIssuer } from "./invitation-issuer.js";
import { createDemoStore } from "./domain.js";
import { createDynamoCareRepository } from "./dynamo-care-repository.js";
import { createHttpApp } from "./http.js";
import { createStringParameterProvider } from "./parameter.js";
import { createFollowUpProcessingProvider } from "./follow-up-processing.js";
import { createUnavailablePublicApp } from "./public-api-gate.js";
import { createBedrockBriefGenerator, WeeklyBriefService } from "./weekly-brief.js";
import { createBedrockIntentGenerator } from "./demo-conversation.js";
import { createFamilyConversationService } from "./family-conversation.js";
import { createDynamoConversationBudget } from "./conversation-budget.js";
import { createPushSubscriptions } from "./push-subscriptions.js";
import { createDynamoReminderTickets } from "./reminder-tickets.js";

export interface RuntimeOptions {
  requireOAuth?: boolean;
  familyAssetDirectory?: string;
}

export function createConfiguredApp(
  environment: NodeJS.ProcessEnv = process.env,
  options: RuntimeOptions = {},
) {
  if (environment.KIN_PUBLIC_API_ENABLED === "false") return createUnavailablePublicApp();
  const mcpAuthMode = parseMcpAuthMode(environment.KIN_MCP_AUTH_MODE);
  const tableName = environment.KIN_DYNAMODB_TABLE?.trim();
  const circleId = environment.KIN_CIRCLE_ID?.trim() || "demo-family";
  const timeZone = environment.KIN_TIME_ZONE?.trim() || "UTC";
  const repository = tableName
    ? createDynamoCareRepository({
        completionUndoEnabled: environment.KIN_COMPLETION_UNDO_ENABLED === "true",
        planPauseEnabled: environment.KIN_PLAN_PAUSE_ENABLED === "true",
        tableName,
        circleId,
        region: environment.AWS_REGION,
        timeZone,
      })
    : createDemoStore(() => new Date(), timeZone);
  const briefModelId = environment.KIN_BEDROCK_MODEL_ID?.trim();
  const briefTimeoutMs = Number.parseInt(environment.KIN_BEDROCK_TIMEOUT_MS ?? "300", 10);
  const workspaceBriefTimeout = environment.KIN_WORKSPACE_BEDROCK_TIMEOUT_MS ?? "5000";
  const workspaceBriefTimeoutMs = Number(workspaceBriefTimeout);
  if (!Number.isInteger(workspaceBriefTimeoutMs) || String(workspaceBriefTimeoutMs) !== workspaceBriefTimeout ||
      workspaceBriefTimeoutMs < 50 || workspaceBriefTimeoutMs > 5000) {
    throw new Error("KIN_WORKSPACE_BEDROCK_TIMEOUT_MS must be a decimal integer from 50 to 5000 milliseconds");
  }
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
    event => console.info(JSON.stringify({ event: "kin_weekly_brief_result", surface: "mcp", ...event })),
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
  const browserEnabled = environment.KIN_BROWSER_AUTH_ENABLED === "true";
  const reminderTicketsEnabled = environment.KIN_REMINDER_TICKETS_ENABLED === "true";
  if (reminderTicketsEnabled && (!familyAccess || !oauthValues.every(Boolean))) throw new Error("Reminder tickets require authenticated family access.");
  const familyEnabled = environment.KIN_FAMILY_WORKSPACE_ENABLED === "true";
  if (familyEnabled && !browserEnabled) {
    throw new Error("Family workspace requires browser sign-in");
  }
  if (browserEnabled && (!oauthValues.every(Boolean) || !familyAccess)) {
    throw new Error("Browser sign-in requires OAuth and a care table");
  }
  const browserAuth = browserEnabled ? browserAuthConfig({
    clientId: environment.KIN_BROWSER_CLIENT_ID ?? "", issuer: oauthIssuer!,
    redirectUri: environment.KIN_BROWSER_REDIRECT_URI ?? "", resource: canonicalMcpUri ?? `${oauthIssuer}/mcp`,
  }) : undefined;
  // Only REST Week gets the browser budget. MCP (including browser Ask) keeps
  // the original brief service and its separate Alexa-oriented timeout.
  const workspaceWeeklyBrief = familyEnabled ? new WeeklyBriefService(
    repository,
    briefModelId ? createBedrockBriefGenerator({
      modelId: briefModelId, region: environment.AWS_REGION, timeoutMs: workspaceBriefTimeoutMs,
    }) : null,
    timeZone,
    event => console.info(JSON.stringify({ event: "kin_weekly_brief_result", surface: "workspace", ...event })),
  ) : undefined;
  const familyConversationEnabled = environment.KIN_FAMILY_CONVERSATION_ENABLED === "true";
  const pushEnabled = environment.KIN_WEB_PUSH_ENABLED === "true";
  const pushPublicKey = environment.KIN_WEB_PUSH_PUBLIC_KEY ?? "";
  if (pushEnabled && (!familyEnabled || !browserAuth || !familyAccess || !/^[A-Za-z0-9_-]{87}$/.test(pushPublicKey))) {
    throw new Error("Push requires the authenticated workspace and a public application key");
  }
  if (familyConversationEnabled && (!familyEnabled || !browserAuth || !familyAccess || !oauthValues.every(Boolean))) {
    throw new Error("Family conversation requires the authenticated family workspace and a care table");
  }
  const familyConversation = familyConversationEnabled ? createFamilyConversationService({
    generate: createBedrockIntentGenerator({ modelId: "amazon.nova-micro-v1:0", region: environment.AWS_REGION, timeoutMs: 5000 }),
    budget: createDynamoConversationBudget({ tableName: tableName!, region: environment.AWS_REGION }),
  }) : undefined;
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
          mcpAuthMode,
          accessAuthorizer: createJwtAccessAuthorizer({
            issuer: oauthIssuer,
            audience: canonicalMcpResource,
            jwksUri: oauthJwksUri,
          }),
          familyAccess,
          automaticFollowUps: familyEnabled && environment.KIN_FOLLOW_UP_PROCESSING_PARAMETER
            ? createFollowUpProcessingProvider({ parameterName: environment.KIN_FOLLOW_UP_PROCESSING_PARAMETER, region: environment.AWS_REGION }) : undefined,
          browserSessions: familyEnabled && environment.KIN_BROWSER_SESSION_ENABLED === "true"
            ? createDynamoBrowserSessions({ tableName: tableName!, region: environment.AWS_REGION }) : undefined,
          rescheduleEnabled: environment.KIN_RESCHEDULE_ENABLED === "true",
          closeUnansweredEnabled: environment.KIN_CLOSE_UNANSWERED_ENABLED === "true",
          reminderTickets: reminderTicketsEnabled ? createDynamoReminderTickets({ tableName: tableName!, circleId }) : undefined,
          push: pushEnabled ? { publicKey: pushPublicKey,
            subscriptions: createPushSubscriptions({ tableName: tableName!, circleId: familyAccess!.circleId, region: environment.AWS_REGION }) } : undefined,
          familyConversation,
          browserAuth: browserAuth && typeof canonicalMcpResource === "function" ? async () => {
            if (await canonicalMcpResource() !== browserAuth.resource) throw new Error("Browser resource does not match canonical MCP resource");
            return browserAuth;
          } : browserAuth,
          serveFamilyWorkspace: familyEnabled,
          publicSiteOrigin: environment.KIN_PUBLIC_SITE_ORIGIN || undefined,
          workspaceWeeklyBrief,
          familyAssetDirectory: options.familyAssetDirectory,
          accessManagement: familyEnabled ? createDynamoAccessManagement({ tableName: tableName!, familyAccess: familyAccess!, region: environment.AWS_REGION }) : undefined,
          rosterManagement: familyEnabled ? createDynamoRosterManagement({ tableName: tableName!, familyAccess: familyAccess!, region: environment.AWS_REGION }) : undefined,
          invitationIssuer: issuingEnabled ? createDynamoInvitationIssuer({
            tableName: tableName!, familyAccess: familyAccess!, circleName: circleName!, issuer: oauthIssuer,
            accounts: createCognitoInvitableAccounts({ userPoolId: userPoolId!, region: environment.AWS_REGION }),
            region: environment.AWS_REGION,
          }) : undefined,
          canonicalMcpUri: canonicalMcpResource,
          authorizationServer: oauthAuthorizationServer,
          serveSimulator: environment.KIN_SERVE_SIMULATOR === "true",
        }
      : { mcpAuthMode, demoIntentGenerator: environment.KIN_DEMO_CONVERSATION_MODEL_ID?.trim()
        ? createBedrockIntentGenerator({ modelId: environment.KIN_DEMO_CONVERSATION_MODEL_ID.trim(), region: environment.AWS_REGION }) : undefined },
  );
}
