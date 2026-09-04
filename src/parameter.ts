import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

interface ParameterSender {
  send(command: GetParameterCommand): Promise<{
    Parameter?: { Value?: string };
  }>;
}

export function createStringParameterProvider(input: {
  parameterName: string;
  region?: string;
  client?: ParameterSender;
}): () => Promise<string> {
  const parameterName = input.parameterName.trim();
  if (!parameterName) throw new Error("SSM parameter name is required");
  const client = input.client ?? new SSMClient({ region: input.region });
  let cached: Promise<string> | undefined;

  return () => {
    cached ??= client.send(new GetParameterCommand({ Name: parameterName }))
      .then((response) => {
        const value = response.Parameter?.Value?.trim();
        if (!value) throw new Error(`SSM parameter ${parameterName} has no value`);
        return value;
      })
      .catch((error) => {
        cached = undefined;
        throw error;
      });
    return cached;
  };
}
