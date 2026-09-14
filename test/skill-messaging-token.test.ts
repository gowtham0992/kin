import { expect, it, vi } from "vitest";
import { createSkillMessagingToken } from "../src/skill-messaging-token.js";
const credentials = { clientId: "client-id-for-test", clientSecret: "x".repeat(32) };
const token = { access_token: "test-token", expires_in: 3600, token_type: "bearer", scope: "alexa:skill_messaging" };
it("uses skill credentials and shares an in-memory token until early expiry", async () => {
  let time = 1000;
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(token));
  const load = createSkillMessagingToken({ credentials: async () => credentials, fetch: request, now: () => time });
  expect(await Promise.all([load(), load()])).toEqual(["test-token", "test-token"]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![0]).toBe("https://api.amazon.com/auth/o2/token");
  expect(new URLSearchParams(String(request.mock.calls[0]![1]!.body)).get("scope")).toBe("alexa:skill_messaging");
  time += 3_540_000;
  await load(); expect(request).toHaveBeenCalledTimes(2);
});
it.each([{ ...token, scope: "wrong" }, { ...token, access_token: "bad\nheader" }, { ...token, expires_in: 0 }, "x".repeat(9000)])("rejects invalid provider responses without leaking them", async body => {
  const load = createSkillMessagingToken({ credentials: async () => credentials, fetch: async () => Response.json(body), now: () => 1000 });
  await expect(load()).rejects.toThrow(/^Reminder synchronization unavailable\.$/);
});
it("does not poison later attempts with a rejected credential request", async () => {
  const secret = vi.fn().mockRejectedValueOnce(new Error("secret")).mockResolvedValue(credentials);
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(token));
  const load = createSkillMessagingToken({ credentials: secret, fetch: request, now: () => 1000 });
  await expect(load()).rejects.toThrow(/^Reminder synchronization unavailable\.$/);
  expect(request).not.toHaveBeenCalled();
  await expect(load()).resolves.toBe("test-token");
});
