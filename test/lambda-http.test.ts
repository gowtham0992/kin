import { describe, expect, it } from "vitest";
import { createLambdaHttpHandler } from "../src/lambda-http.js";

describe("Lambda header serialization", () => {
  it.each(["object", "raw"])("preserves %s headers, multiple cookies, and preexisting headers", async (format) => {
    const handler = createLambdaHttpHandler((_request, response) => {
      response.setHeader("x-existing", "kept");
      const headers = format === "object"
        ? { "content-type": "application/json", "set-cookie": ["one=1; HttpOnly", "two=2; HttpOnly"] }
        : ["content-type", "application/json", "set-cookie", "one=1; HttpOnly", "set-cookie", "two=2; HttpOnly"];
      response.writeHead(201, "Created", headers);
      response.end('{"ok":true}');
    });
    const response = await handler({
      version: "2.0", routeKey: "$default", rawPath: "/", rawQueryString: "",
      headers: { host: "api.example.com" },
      requestContext: { http: { method: "GET", path: "/", sourceIp: "127.0.0.1" }, stage: "$default" },
      isBase64Encoded: false,
    }, {} as never, () => {});
    expect(response.statusCode).toBe(201);
    expect(new Headers(response.headers).get("content-type")).toBe("application/json");
    expect(new Headers(response.headers).get("x-existing")).toBe("kept");
    expect(response.cookies).toEqual(["one=1; HttpOnly", "two=2; HttpOnly"]);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });
});
