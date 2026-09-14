// Pure launch policy. No credential lookup or cloud client is constructed here.
export function localStoryLaunch(args: string[], environment: NodeJS.ProcessEnv) {
  if (args.length === 1 && args[0] === "--help") return { help: true as const };
  if (args.length > 1 || (args.length === 1 && args[0] !== "--bedrock")) {
    throw new Error("Supported story option: --bedrock (or --help)");
  }
  const rawPort = environment.PORT ?? "3030";
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65_535) {
    throw new Error("PORT must be an integer between 1024 and 65535");
  }
  if (args.length === 0) return { help: false as const, port: Number(rawPort), model: null };
  const profile = environment.AWS_PROFILE;
  if (!profile || profile !== profile.trim() || /[\u0000-\u001f\u007f]/.test(profile)) {
    throw new Error("Set AWS_PROFILE explicitly to your Kin application profile before enabling Bedrock");
  }
  if (["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"]
    .some(name => environment[name] !== undefined)) {
    throw new Error("Remove ambient AWS credential and Bedrock bearer-token variables before using the explicitly selected story profile");
  }
  if (environment.AWS_REGION && environment.AWS_REGION !== "us-east-1") {
    throw new Error("The Kin story uses Bedrock in us-east-1");
  }
  return { help: false as const, port: Number(rawPort), model: {
    profile, region: "us-east-1", modelId: "amazon.nova-micro-v1:0", timeoutMs: 5000,
  } };
}
