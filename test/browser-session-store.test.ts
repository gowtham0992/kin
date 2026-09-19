import { describe, it, expect, vi } from "vitest";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createDynamoBrowserSessions } from "../src/browser-session.js";
describe("Dynamo browser sessions", () => {
  it("hashes session IDs, uses the existing seconds-based TTL and reads consistently", async () => {
    let item: Record<string,unknown> | undefined;
    const send=vi.fn(async (command:GetCommand|PutCommand|UpdateCommand) => {
      if(command instanceof PutCommand){item=command.input.Item;return {};}
      return {Item:item};
    });
    const store=createDynamoBrowserSessions({tableName:"synthetic-table",client:{send}});
    const id="synthetic-session-id";
    await store.put(id,{token:"synthetic-token",expiresAt:4600123});
    expect(item).toMatchObject({expiresAt:4601,validUntilMs:4600123});
    expect(item?.PK).toMatch(/^BROWSER_SESSION#[a-f0-9]{64}$/);
    expect(JSON.stringify(item)).not.toContain(id);
    expect(await store.get(id)).toEqual({token:"synthetic-token",expiresAt:4600123});
    expect(send.mock.calls[1]![0].input).toMatchObject({ConsistentRead:true});
    expect(send.mock.calls[0]![0].input).toMatchObject({ConditionExpression:"attribute_not_exists(PK)"});
  });
  it("removes bearer credentials when revoked and does not authenticate tombstones", async () => {
    const send=vi.fn(async (command:GetCommand|PutCommand|UpdateCommand) => command instanceof GetCommand ? {Item:{revoked:true}} : {});
    const store=createDynamoBrowserSessions({tableName:"synthetic-table",client:{send}});
    await store.revoke("synthetic");
    expect(send.mock.calls[0]![0].input).toMatchObject({UpdateExpression:"SET revoked = :yes REMOVE #token"});
    expect(await store.get("synthetic")).toBeNull();
  });
  it("does not claim logout succeeded when the database fails", async () => {
    const store=createDynamoBrowserSessions({tableName:"synthetic-table",client:{send:async()=>{throw new Error("unavailable");}}});
    await expect(store.revoke("synthetic")).rejects.toThrow("unavailable");
  });
});
