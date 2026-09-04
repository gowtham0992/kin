import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

type AdapterPayload = Record<string, unknown> & {
  grantId?: string;
  uid?: string;
  userCode?: string;
};

type AdapterCommand =
  | GetCommand
  | QueryCommand
  | TransactWriteCommand
  | UpdateCommand;

interface AdapterSender {
  send(command: AdapterCommand): Promise<Record<string, unknown>>;
}

export interface DynamoOidcAdapterConfig {
  tableName: string;
  region?: string;
  client?: AdapterSender;
  clockToleranceSeconds?: number;
  now?: () => Date;
}

interface StateItem {
  PK: string;
  SK: string;
  model: string;
  id: string;
  payload: AdapterPayload;
  expiresAt?: number;
}

interface LookupItem {
  PK: string;
  SK: string;
  model: string;
  id: string;
  expiresAt?: number;
}

const modelPattern = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const grantModels = new Set([
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
  "PreAuthorizedCode",
]);

export function createDynamoOidcAdapter(config: DynamoOidcAdapterConfig) {
  const tableName = config.tableName.trim();
  if (!tableName) throw new Error("OAuth state table name is required");
  const client = config.client ?? DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: config.region }),
  );
  const now = config.now ?? (() => new Date());
  const clockTolerance = config.clockToleranceSeconds ?? 0;

  return class DynamoOidcAdapter {
    readonly #model: string;

    constructor(model: string) {
      if (!modelPattern.test(model)) throw new Error("Invalid OAuth adapter model name");
      this.#model = model;
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      const expiresAt = typeof expiresIn === "number"
        ? Math.floor(now().getTime() / 1000) + expiresIn + clockTolerance
        : undefined;
      const state: StateItem = {
        PK: modelKey(this.#model),
        SK: valueKey(id),
        model: this.#model,
        id,
        payload,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
      const puts: Array<{
        Put: { TableName: string; Item: StateItem | LookupItem };
      }> = [{ Put: { TableName: tableName, Item: state } }];

      if (this.#model === "Session" && payload.uid) {
        puts.push({ Put: { TableName: tableName, Item: lookupItem("UID", payload.uid, this.#model, id, expiresAt) } });
      }
      if (payload.userCode) {
        puts.push({ Put: { TableName: tableName, Item: lookupItem("USER_CODE", payload.userCode, this.#model, id, expiresAt) } });
      }
      if (grantModels.has(this.#model) && payload.grantId) {
        puts.push({ Put: { TableName: tableName, Item: grantItem(payload.grantId, this.#model, id, expiresAt) } });
      }

      await client.send(new TransactWriteCommand({ TransactItems: puts }));
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      const result = await client.send(new GetCommand({
        TableName: tableName,
        Key: { PK: modelKey(this.#model), SK: valueKey(id) },
        ConsistentRead: true,
      })) as { Item?: StateItem };
      if (!result.Item || expired(result.Item.expiresAt, now())) return undefined;
      return result.Item.payload;
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      return this.#findByLookup("UID", uid);
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
      return this.#findByLookup("USER_CODE", userCode);
    }

    async consume(id: string): Promise<void> {
      await client.send(new UpdateCommand({
        TableName: tableName,
        Key: { PK: modelKey(this.#model), SK: valueKey(id) },
        UpdateExpression: "SET #payload.#consumed = :consumed",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: {
          "#payload": "payload",
          "#consumed": "consumed",
        },
        ExpressionAttributeValues: {
          ":consumed": Math.floor(now().getTime() / 1000),
        },
      }));
    }

    async destroy(id: string): Promise<void> {
      const payload = await this.find(id);
      const deletes = [{
        Delete: {
          TableName: tableName,
          Key: { PK: modelKey(this.#model), SK: valueKey(id) },
        },
      }];
      if (this.#model === "Session" && payload?.uid) {
        deletes.push({ Delete: { TableName: tableName, Key: lookupKey("UID", payload.uid, this.#model) } });
      }
      if (payload?.userCode) {
        deletes.push({ Delete: { TableName: tableName, Key: lookupKey("USER_CODE", payload.userCode, this.#model) } });
      }
      if (grantModels.has(this.#model) && payload?.grantId) {
        deletes.push({ Delete: { TableName: tableName, Key: grantKey(payload.grantId, this.#model, id) } });
      }
      await client.send(new TransactWriteCommand({ TransactItems: deletes }));
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const result = await client.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": grantPartition(grantId) },
          ExclusiveStartKey: exclusiveStartKey,
          ConsistentRead: true,
        })) as { Items?: LookupItem[]; LastEvaluatedKey?: Record<string, unknown> };
        const members = result.Items ?? [];
        for (let offset = 0; offset < members.length; offset += 50) {
          const transactions = members.slice(offset, offset + 50).flatMap((member) => [
            {
              Delete: {
                TableName: tableName,
                Key: { PK: modelKey(member.model), SK: valueKey(member.id) },
              },
            },
            {
              Delete: {
                TableName: tableName,
                Key: { PK: member.PK, SK: member.SK },
              },
            },
          ]);
          if (transactions.length > 0) {
            await client.send(new TransactWriteCommand({ TransactItems: transactions }));
          }
        }
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
    }

    async #findByLookup(kind: "UID" | "USER_CODE", value: string) {
      const result = await client.send(new GetCommand({
        TableName: tableName,
        Key: lookupKey(kind, value, this.#model),
        ConsistentRead: true,
      })) as { Item?: LookupItem };
      if (!result.Item || expired(result.Item.expiresAt, now())) return undefined;
      return this.find(result.Item.id);
    }
  };
}

function modelKey(model: string) {
  return `MODEL#${model}`;
}

function valueKey(id: string) {
  return `VALUE#${id}`;
}

function lookupKey(kind: "UID" | "USER_CODE", value: string, model: string) {
  return { PK: `LOOKUP#${kind}#${value}`, SK: `MODEL#${model}` };
}

function lookupItem(
  kind: "UID" | "USER_CODE",
  value: string,
  model: string,
  id: string,
  expiresAt?: number,
): LookupItem {
  return {
    ...lookupKey(kind, value, model),
    model,
    id,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function grantPartition(grantId: string) {
  return `GRANT#${grantId}`;
}

function grantKey(grantId: string, model: string, id: string) {
  return { PK: grantPartition(grantId), SK: `${model}#${id}` };
}

function grantItem(grantId: string, model: string, id: string, expiresAt?: number): LookupItem {
  return {
    ...grantKey(grantId, model, id),
    model,
    id,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function expired(expiresAt: number | undefined, now: Date) {
  return expiresAt !== undefined && expiresAt <= Math.floor(now.getTime() / 1000);
}
