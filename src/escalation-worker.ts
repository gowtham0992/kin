import type { Context, Handler } from "aws-lambda";
import { z } from "zod";
import type { CareRepository } from "./domain.js";
import { createDynamoCareRepository } from "./dynamo-care-repository.js";
import {
  type AlertPublisher,
  type EscalationStatus,
  runEscalationSweep,
} from "./escalation.js";
import { createSnsAlertPublisher } from "./sns-alert-publisher.js";

const scheduledEventSchema = z.object({
  source: z.literal("kin.scheduler"),
}).strict();

const environmentSchema = z.object({
  AWS_REGION: z.string().trim().min(1),
  KIN_DYNAMODB_TABLE: z.string().trim().min(3).max(255),
  KIN_ALERT_TOPIC_ARN: z.string().trim().regex(/^arn:[^:]+:sns:[^:]+:[0-9]{12}:[A-Za-z0-9_-]+$/),
  KIN_CIRCLE_ID: z.string().trim().regex(/^[A-Za-z0-9_-]{1,80}$/),
  KIN_TIME_ZONE: z.string().trim().min(1).max(80),
  KIN_GRACE_MINUTES: z.coerce.number().int().min(0).max(1_440),
});

export interface EscalationSweepResult {
  evaluatedAt: string;
  evaluatedTasks: number;
  counts: Partial<Record<EscalationStatus, number>>;
}

export interface EscalationWorkerDependencies {
  repository: CareRepository;
  publisher: AlertPublisher;
  graceMinutes: number;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

export function createEscalationWorker(dependencies: EscalationWorkerDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? ((entry) => console.info(JSON.stringify(entry)));

  return async (event: unknown, requestId: string): Promise<EscalationSweepResult> => {
    scheduledEventSchema.parse(event);
    if (!requestId || requestId.length > 128) throw new Error("A valid invocation request ID is required");
    const evaluatedAt = now();
    const snapshot = await dependencies.repository.escalationSnapshot(evaluatedAt);
    const result = await runEscalationSweep({
      snapshot,
      store: dependencies.repository,
      publisher: dependencies.publisher,
      now: evaluatedAt,
      graceMinutes: dependencies.graceMinutes,
      attemptId: requestId,
    });
    const counts = result.records.reduce<Partial<Record<EscalationStatus, number>>>(
      (summary, record) => {
        summary[record.status] = (summary[record.status] ?? 0) + 1;
        return summary;
      },
      {},
    );
    const response = {
      evaluatedAt: evaluatedAt.toISOString(),
      evaluatedTasks: snapshot.tasks.length,
      counts,
    };
    log({ event: "kin.escalation_sweep.completed", ...response });
    return response;
  };
}

let productionWorker: ReturnType<typeof createEscalationWorker> | undefined;

export const handler: Handler<unknown, EscalationSweepResult> = async (event, context: Context) => {
  productionWorker ??= createWorkerFromEnvironment(process.env);
  return productionWorker(event, context.awsRequestId);
};

function createWorkerFromEnvironment(environment: NodeJS.ProcessEnv) {
  const config = environmentSchema.parse(environment);
  const repository = createDynamoCareRepository({
    tableName: config.KIN_DYNAMODB_TABLE,
    circleId: config.KIN_CIRCLE_ID,
    region: config.AWS_REGION,
    timeZone: config.KIN_TIME_ZONE,
  });
  return createEscalationWorker({
    repository,
    publisher: createSnsAlertPublisher({
      topicArn: config.KIN_ALERT_TOPIC_ARN,
      region: config.AWS_REGION,
    }),
    graceMinutes: config.KIN_GRACE_MINUTES,
  });
}
