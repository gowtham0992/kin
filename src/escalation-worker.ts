import type { Context, Handler } from "aws-lambda";
import { z } from "zod";
import type { CareRepository } from "./domain.js";
import { createDynamoCareRepository } from "./dynamo-care-repository.js";
import {
  type AlertPublisher,
  type EscalationStatus,
  type EscalationSummary,
  runEscalationSweep,
} from "./escalation.js";
import { createSnsAlertPublisher } from "./sns-alert-publisher.js";
import { createConfiguredPushPublisher } from "./push-runtime.js";

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

export interface EscalationPausedResult extends EscalationSweepResult {
  status: "paused";
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
  // One object argument preserves $.message.* fields with Lambda JSON logging.
  const log = dependencies.log ?? ((entry) => console.info(entry));

  return async (event: unknown, requestId: string): Promise<EscalationSweepResult> => {
    validateInvocation(event, requestId);
    const snapshot = await dependencies.repository.escalationSnapshot(now());
    // Independent of the care-plan date: unresolved operational failures must
    // not recover just because their tasks leave Today. Read before publishing;
    // an incomplete health query aborts rather than emitting a false zero.
    const outstanding = await dependencies.repository.deliveryHealthSnapshot();
    // A reply returned by this read may have been recorded after the read began.
    const evaluatedAt = now();
    const result = await runEscalationSweep({
      snapshot,
      store: dependencies.repository,
      publisher: dependencies.publisher,
      now: evaluatedAt,
      completionClock: now,
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
    // Failed/blocked records can outlive the task's eligibility for a new sweep.
    // Latest outcomes replace the snapshot by ID so a successful retry clears it.
    const latest = new Map([...snapshot.escalations, ...outstanding].map(record => [record.id, record]));
    for (const record of result.records) latest.set(record.id, record);
    log({ event: "kin.escalation_delivery.health", evaluatedAt: response.evaluatedAt,
      ...deliveryHealth([...latest.values()], evaluatedAt) });
    return response;
  };
}

function deliveryHealth(records: EscalationSummary[], asOf: Date) {
  const health = { failed: 0, blocked: 0, receiptPending: 0, stuck: 0 };
  for (const record of records) {
    if (record.status === "failed") health.failed += 1;
    if (record.status === "blocked") health.blocked += 1;
    if (record.status === "receipt_pending") health.receiptPending += 1;
    if (record.status === "queued" || record.status === "sending") {
      const updatedAt = Date.parse(record.updatedAt);
      if (!Number.isFinite(updatedAt) || asOf.getTime() - updatedAt >= 15 * 60_000) health.stuck += 1;
    }
  }
  return health;
}

function validateInvocation(event: unknown, requestId: string) {
  scheduledEventSchema.parse(event);
  if (!requestId || requestId.length > 128) throw new Error("A valid invocation request ID is required");
}

// The pure worker above is used by explicit local fixtures. Production must go
// through this boundary so a paused invocation never constructs AWS clients.
export function createConfiguredEscalationWorker(environment: NodeJS.ProcessEnv, options: {
  createWorker?: (environment: NodeJS.ProcessEnv) => ReturnType<typeof createEscalationWorker>;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
} = {}) {
  let worker: ReturnType<typeof createEscalationWorker> | undefined;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((entry) => console.info(JSON.stringify(entry)));
  return async (event: unknown, requestId: string): Promise<EscalationSweepResult | EscalationPausedResult> => {
    validateInvocation(event, requestId);
    const enabled = environment.KIN_ESCALATION_WORKER_ENABLED ?? "false";
    if (enabled !== "true" && enabled !== "false") {
      throw new Error("KIN_ESCALATION_WORKER_ENABLED must be true or false");
    }
    if (enabled === "false") {
      const result: EscalationPausedResult = {
        status: "paused", evaluatedAt: now().toISOString(), evaluatedTasks: 0, counts: {},
      };
      log({ event: "kin.escalation_sweep.paused", ...result });
      return result;
    }
    worker ??= (options.createWorker ?? createWorkerFromEnvironment)(environment);
    return worker(event, requestId);
  };
}

let productionWorker: ReturnType<typeof createConfiguredEscalationWorker> | undefined;

export const handler: Handler<unknown, EscalationSweepResult | EscalationPausedResult> = async (event, context: Context) => {
  productionWorker ??= createConfiguredEscalationWorker(process.env);
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
    publisher: environment.KIN_WEB_PUSH_ENABLED === "true" ? createConfiguredPushPublisher(environment) : createSnsAlertPublisher({
      topicArn: config.KIN_ALERT_TOPIC_ARN,
      region: config.AWS_REGION,
    }),
    graceMinutes: config.KIN_GRACE_MINUTES,
  });
}
