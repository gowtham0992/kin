import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { KinEchoStack } from "../infra/kin-echo-stack.js";

describe("isolated Echo development infrastructure", () => {
  let template: Template;
  let bundlePath: string;
  beforeAll(() => {
    const app = new App();
    template = Template.fromStack(new KinEchoStack(app, "EchoInfrastructureTest", {
      env: { account: "123456789012", region: "us-east-1" },
    }));
    const functionResource = Object.values(template.findResources("AWS::Lambda::Function"))[0]!;
    const assetHash = (functionResource.Properties.Code.S3Key as string).replace(/\.zip$/, "");
    bundlePath = path.join(app.synth().directory, `asset.${assetHash}`, "index.js");
  }, 30_000);

  it("requires an explicit valid Skill ID and starts with the greeting paused", () => {
    const skillParameter = template.toJSON().Parameters.EchoSkillId;
    expect(skillParameter.Type).toBe("String");
    expect(skillParameter).not.toHaveProperty("Default");
    const validSkillId = "amzn1.ask.skill.a7cb5179-6d37-4fe3-bb53-f39193f67ed6";
    const valid = new RegExp(skillParameter.AllowedPattern);
    expect(valid.test(validSkillId)).toBe(true);
    for (const invalid of ["", "*", "amzn1.ask.skill.*", `${validSkillId}/extra`, `prefix${validSkillId}`]) {
      expect(valid.test(invalid)).toBe(false);
    }
    template.hasParameter("EchoEnabled", {
      Type: "String", Default: "false", AllowedValues: ["true", "false"],
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "kin-echo-development",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 512,
      LoggingConfig: { SystemLogLevel: "INFO", ApplicationLogLevel: "INFO", LogFormat: "JSON" },
      Timeout: 7,
      Environment: { Variables: {
        KIN_ECHO_SKILL_ID: { Ref: "EchoSkillId" },
        KIN_ECHO_ENABLED: { Ref: "EchoEnabled" },
        KIN_ECHO_CARE_ENABLED: { Ref: "EchoCareEnabled" },
        KIN_ECHO_MCP_ENDPOINT: { Ref: "EchoMcpEndpoint" },
        KIN_ECHO_TIME_ZONE: "America/Denver",
        KIN_ECHO_REMINDER_TEST_ENABLED: { Ref: "EchoReminderTestEnabled" },
        KIN_ECHO_REMINDER_CLAIMS_TABLE: { Ref: Object.keys(template.findResources("AWS::DynamoDB::Table"))[0]! },
      } },
    });
    const functions = Object.values(template.findResources("AWS::Lambda::Function"));
    expect(functions).toHaveLength(1);
    expect(functions[0]!.Properties.Environment.Variables).toEqual({
      KIN_ECHO_SKILL_ID: { Ref: "EchoSkillId" },
      KIN_ECHO_ENABLED: { Ref: "EchoEnabled" },
      KIN_ECHO_TIME_ZONE: "America/Denver",
      KIN_ECHO_CARE_ENABLED: { Ref: "EchoCareEnabled" },
      KIN_ECHO_MCP_ENDPOINT: { Ref: "EchoMcpEndpoint" },
      KIN_ECHO_REMINDER_TEST_ENABLED: { Ref: "EchoReminderTestEnabled" },
      KIN_ECHO_REMINDER_CLAIMS_TABLE: { Ref: Object.keys(template.findResources("AWS::DynamoDB::Table"))[0]! },
      KIN_ECHO_REMINDER_SYNC_ENABLED: { Ref: "EchoReminderSyncEnabled" },
      KIN_ECHO_PLAN_CANCEL_SYNC_ENABLED: { Ref: "EchoPlanCancelSyncEnabled" },
      KIN_ECHO_REMINDER_SYNC_TABLE: "kin-echo-reminder-sync",
      KIN_ECHO_UNDO_ENABLED: { Ref: "EchoUndoEnabled" },
      KIN_ECHO_PLAN_PAUSE_ENABLED: { Ref: "EchoPlanPauseEnabled" },
    });
  });

  it("keeps linked family access off until an exact HTTPS MCP endpoint is configured", () => {
    template.hasParameter("EchoCareEnabled", {
      Type: "String", Default: "false", AllowedValues: ["true", "false"],
    });
    const endpoint = template.toJSON().Parameters.EchoMcpEndpoint;
    expect(endpoint.Type).toBe("String");
    expect(endpoint.Default).toBe("");
    expect(endpoint.MaxLength).toBe(2048);
    const valid = new RegExp(endpoint.AllowedPattern);
    for (const accepted of ["", "https://kin.example.com/mcp", "https://abc.execute-api.us-east-1.amazonaws.com/mcp"]) {
      expect(valid.test(accepted), accepted).toBe(true);
    }
    for (const rejected of [
      "http://kin.example.com/mcp", "https://kin.example.com", "https://kin.example.com/mcp/",
      "https://kin.example.com/mcp?token=secret", "https://kin.example.com/mcp#extra",
      "https://user:password@kin.example.com/mcp", "https://kin.example.com:443/mcp",
      "https://kin.example.com/other/mcp", "https://KIN.example.com/mcp",
      "https://kin..example.com/mcp", "https://-kin.example.com/mcp", "https://kin.example.com/mcp\n",
    ]) {
      expect(valid.test(rejected), rejected).toBe(false);
    }
    expect(template.toJSON().Rules.EchoCareEndpointRequired).toEqual({
      RuleCondition: { "Fn::Equals": [{ Ref: "EchoCareEnabled" }, "true"] },
      Assertions: [{
        Assert: { "Fn::Not": [{ "Fn::Equals": [{ Ref: "EchoMcpEndpoint" }, ""] }] },
        AssertDescription: "Echo care requires an explicitly configured HTTPS MCP endpoint.",
      }],
    });
  });

  it("permits only the configured Alexa Skill through EventSourceToken", () => {
    const permissions = Object.values(template.findResources("AWS::Lambda::Permission"));
    const functionId = Object.keys(template.findResources("AWS::Lambda::Function"))[0]!;
    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.Properties).toEqual({
      Action: "lambda:InvokeFunction",
      Principal: "alexa-appkit.amazon.com",
      EventSourceToken: { Ref: "EchoSkillId" },
      FunctionName: { "Fn::GetAtt": [functionId, "Arn"] },
    });
  });

  it("grants only log writes and claims in the dedicated reminder table", () => {
    const roles = template.findResources("AWS::IAM::Role");
    const roleId = Object.keys(roles)[0]!;
    expect(Object.keys(roles)).toHaveLength(1);
    expect(roles[roleId]!.Properties).not.toHaveProperty("ManagedPolicyArns");
    expect(roles[roleId]!.Properties.AssumeRolePolicyDocument.Statement).toEqual([{
      Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: "lambda.amazonaws.com" },
    }]);
    const logGroups = template.findResources("AWS::Logs::LogGroup");
    const logId = Object.keys(logGroups)[0]!;
    expect(Object.keys(logGroups)).toHaveLength(1);
    expect(logGroups[logId]).toMatchObject({
      Properties: { LogGroupName: "/aws/lambda/kin-echo-development", RetentionInDays: 7 },
      DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
    });
    const allPolicies = Object.values(template.findResources("AWS::IAM::Policy"));
    expect(allPolicies).toHaveLength(2);
    const policies = allPolicies.filter(policy => !policy.Condition);
    expect(policies).toHaveLength(1);
    expect(policies[0]!.Properties.Roles).toEqual([{ Ref: roleId }]);
    expect(policies[0]!.Properties.PolicyDocument.Statement).toEqual([{
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: { "Fn::GetAtt": [logId, "Arn"] },
    }, {
      Effect: "Allow", Action: "dynamodb:PutItem",
      Resource: { "Fn::GetAtt": [Object.keys(template.findResources("AWS::DynamoDB::Table"))[0]!, "Arn"] },
    }]);
  });

  it("pins the named runtime role to the externally managed Echo permissions boundary", () => {
    const roles = Object.values(template.findResources("AWS::IAM::Role"));
    expect(roles).toHaveLength(1);
    expect(roles[0]!.Properties.PermissionsBoundary).toEqual({
      "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::123456789012:policy/KinEchoRuntimeBoundary"]],
    });
    expect(roles[0]!.Properties.RoleName).toBe("kin-echo-development-role");
    template.resourceCountIs("AWS::IAM::ManagedPolicy", 0);
  });

  it("isolates reminder claims from family data and keeps reminders disabled by default", () => {
    const resources = template.toJSON().Resources as Record<string, { Type: string }>;
    expect([...new Set(Object.values(resources).map(resource => resource.Type))].sort()).toEqual([
      "AWS::DynamoDB::Table", "AWS::IAM::Policy", "AWS::IAM::Role", "AWS::Lambda::Function", "AWS::Lambda::Permission", "AWS::Logs::LogGroup",
    ]);
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain("Fn::ImportValue");
    expect(json).not.toContain("kin-care-state");
    expect(json).not.toContain("KIN_MCP");
    template.hasParameter("EchoReminderTestEnabled", { Type: "String", Default: "false" });
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "kin-echo-reminder-claims", BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true }, DeletionProtectionEnabled: true,
    });
    const functionId = Object.keys(template.findResources("AWS::Lambda::Function"))[0]!;
    template.hasOutput("EchoFunctionArn", { Value: { "Fn::GetAtt": [functionId, "Arn"] } });
    template.hasOutput("EchoSkillIdOutput", { Value: { Ref: "EchoSkillId" } });
  });

  it("runs the actual CommonJS deployment handler with greeting, deny, and pause behavior intact", () => {
    const skillId = "amzn1.ask.skill.00000000-0000-0000-0000-000000000001";
    const launch = {
      version: "1.0",
      context: { System: { application: { applicationId: skillId } } },
      request: { type: "LaunchRequest", requestId: "synthetic-bundle-test", timestamp: "2026-09-10T12:00:00Z", locale: "en-US" },
    };
    const invoke = (enabled: string, event: unknown) => JSON.parse(execFileSync(process.execPath, [
      "--input-type=commonjs", "-e",
      "const { handler } = require(process.argv[1]); handler(JSON.parse(process.argv[2])).then(response => process.stdout.write(JSON.stringify({ response }))).catch(error => process.stdout.write(JSON.stringify({ error: error.message })));",
      bundlePath, JSON.stringify(event),
    ], { env: {
      ...process.env, KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: enabled,
      KIN_ECHO_CARE_ENABLED: "false", KIN_ECHO_MCP_ENDPOINT: "",
    }, encoding: "utf8", timeout: 5_000 }));

    const enabled = invoke("true", launch);
    expect(enabled.response.response.outputSpeech.ssml).toContain("Your family account is not connected yet");
    expect(enabled.response.response.shouldEndSession).toBe(false);
    const wrongSkill = { ...launch, context: { System: { application: {
      applicationId: "amzn1.ask.skill.00000000-0000-0000-0000-000000000002",
    } } } };
    expect(invoke("true", wrongSkill)).toEqual({ error: "Invalid Kin Echo request." });
    const paused = invoke("false", launch);
    expect(paused.response.response.outputSpeech.ssml).toContain("voice testing is paused");
    expect(paused.response.response.shouldEndSession).toBe(true);
  });

  it.each([true, false])("runs the bundled MCP care path without real networking, linked account=%s", linked => {
    const skillId = "amzn1.ask.skill.00000000-0000-0000-0000-000000000001";
    const endpoint = "https://kin-bundle.example/mcp";
    const token = "synthetic-private-linked-token";
    const launch = {
      version: "1.0",
      session: { new: true, sessionId: "synthetic-bundle-session", application: { applicationId: skillId },
        attributes: { privateNote: "synthetic-unrelated-note" } },
      context: { System: { application: { applicationId: skillId },
        user: { userId: "synthetic-alexa-user", ...(linked ? { accessToken: token } : {}) },
        apiAccessToken: "synthetic-unrelated-alexa-token" } },
      request: { type: "LaunchRequest", requestId: "synthetic-bundled-care-test", timestamp: "2026-09-11T18:00:00Z", locale: "en-US" },
    };
    const snapshot = {
      date: "2026-09-11",
      tasks: [{ id: "bundled-water", title: "Bundled water check-in", dueAt: "2026-09-11T20:00:00.000Z",
        state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null }],
      onDuty: null, escalations: [], summary: { total: 1, completed: 0, remaining: 1, skipped: 0 },
    };
    // Run the synthesized deployment artifact, not a TypeScript import. This
    // catches CommonJS/runtime packaging regressions hidden by source-level tests.
    const script = `
      const assert = require("node:assert/strict");
      const snapshot = JSON.parse(process.argv[3]);
      const frames = [];
      const diagnostics = [];
      console.info = message => diagnostics.push(JSON.parse(message));
      globalThis.fetch = async (url, init = {}) => {
        assert.equal(String(url), process.env.KIN_ECHO_MCP_ENDPOINT);
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        assert.equal(init.credentials, "omit");
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-private-linked-token");
        const frame = JSON.parse(init.body);
        frames.push({ method: frame.method, ...(frame.params?.name ? { name: frame.params.name } : {}) });
        if (frame.method === "notifications/initialized") return new Response(null, { status: 202 });
        let result;
        if (frame.method === "initialize") {
          result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "kin-bundle-fixture", version: "1" } };
        } else {
          assert.equal(frame.method, "tools/call");
          assert.equal(frame.params.name, "show_today");
          assert.deepEqual(frame.params.arguments, {});
          result = { content: [{ type: "text", text: "UNTRUSTED_TOOL_TEXT" }], structuredContent: snapshot };
        }
        return Response.json({ jsonrpc: "2.0", id: frame.id, result });
      };
      const { handler } = require(process.argv[1]);
      handler(JSON.parse(process.argv[2]))
        .then(response => process.stdout.write(JSON.stringify({ response, frames, diagnostics })))
        .catch(error => process.stdout.write(JSON.stringify({ error: error.message, frames, diagnostics })));
    `;
    const output = execFileSync(process.execPath, ["--input-type=commonjs", "-e", script,
      bundlePath, JSON.stringify(launch), JSON.stringify(snapshot)], {
      env: { ...process.env, KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true",
        KIN_ECHO_CARE_ENABLED: "true", KIN_ECHO_MCP_ENDPOINT: endpoint }, encoding: "utf8", timeout: 5_000,
    });
    expect(output).not.toMatch(/synthetic-private-linked-token|synthetic-unrelated-alexa-token|synthetic-unrelated-note|UNTRUSTED_TOOL_TEXT/);
    const result = JSON.parse(output);
    expect(result).not.toHaveProperty("error");
    expect(result.diagnostics).toHaveLength(linked ? 1 : 0);
    if (linked) expect(result.diagnostics[0]).toMatchObject({ event: "kin_echo_care_result", outcome: "success" });
    if (linked) {
      expect(result.frames).toEqual([
        { method: "initialize" }, { method: "notifications/initialized" }, { method: "tools/call", name: "show_today" },
      ]);
      expect(result.response.response.outputSpeech.ssml).toContain("1. Bundled water check-in");
      expect(result.response.response.shouldEndSession).toBe(false);
      expect(result.response.response.card).toBeUndefined();
    } else {
      expect(result.frames).toEqual([]);
      expect(result.response.response.card).toEqual({ type: "LinkAccount" });
      expect(result.response.response.shouldEndSession).toBe(true);
      expect(result.response.response.outputSpeech.ssml).not.toContain("Bundled water check-in");
    }
  });
});
import { execFileSync } from "node:child_process";
import path from "node:path";
