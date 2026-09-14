import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-provider-ini";

// A profile on the default chain is only a preference: a missing profile can
// fall through to unrelated ambient credentials. Resolve this named profile
// directly, including only the sources it explicitly configures.
export function createLocalStoryBedrockClient(model: { profile: string; region: string }) {
  return new BedrockRuntimeClient({
    profile: model.profile,
    region: model.region,
    maxAttempts: 1,
    credentials: fromIni({ profile: model.profile }),
    authSchemePreference: ["sigv4"],
    // Ignore any later ambient bearer-token changes as well as the launch-time
    // rejection. A profile credential failure must never switch identities.
    token: async () => { throw new Error("The Kin story does not use bearer-token authentication"); },
  });
}
