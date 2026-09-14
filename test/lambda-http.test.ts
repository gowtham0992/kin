import { describe, expect, it, vi } from "vitest";
import type { Socket } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import express from "express";
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

describe("Lambda request lifecycle", () => {
  const event = {
    version: "2.0", routeKey: "$default", rawPath: "/", rawQueryString: "",
    headers: { host: "lambda-lifecycle.synthetic.test", "content-type": "application/json" },
    requestContext: { http: { method: "POST", path: "/", sourceIp: "127.0.0.1" }, stage: "$default" },
    body: '{"value":"synthetic-body"}', isBase64Encoded: false,
  };

  it("keeps JSON readable after deferred middleware before the parser", async () => {
    const app = express();
    app.use(async (_request, _response, next) => { await new Promise<void>(resolve => setImmediate(resolve)); next(); });
    app.use(express.json());
    app.post("/", (request, response) => { response.json({ value: request.body?.value ?? null }); });
    const result = await createLambdaHttpHandler(app)(event, {} as never, () => {});
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ value: "synthetic-body" });
  });

  it("retains parse-error handling after deferred middleware", async () => {
    const app = express();
    app.use(async (_request, _response, next) => { await new Promise<void>(resolve => setImmediate(resolve)); next(); });
    app.use(express.json());
    app.post("/", (_request, response) => { response.json({ accepted: true }); });
    app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status(400).json({ error: "invalid_json" });
    });
    const result = await createLambdaHttpHandler(app)({ ...event, body: "{malformed" }, {} as never, () => {});
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "invalid_json" });
  });

  it.each([
    { path: "/not-found", method: "GET", staticRoute: false },
    { path: "/not-found", method: "HEAD", staticRoute: false },
    { path: "/not-found", method: "PATCH", staticRoute: false },
    { path: "/missing-synthetic-asset.css", method: "GET", staticRoute: true },
  ])("completes the default final handler for $method $path (static: $staticRoute)", async ({ path, method, staticRoute }) => {
    const app = express();
    if (staticRoute) app.use(express.static(new URL("../simulator", import.meta.url).pathname));
    const result = await createLambdaHttpHandler(app)({ ...event, rawPath: path,
      requestContext: { ...event.requestContext, http: { ...event.requestContext.http, method, path } },
    }, {} as never, () => {});
    expect(result.statusCode).toBe(404);
    if (method === "HEAD") expect(result.body).toBe("");
    else expect(result.body).toContain(`Cannot ${method} ${path}`);
  }, 1000);

  it("completes a deferred bodyless response and removes its lifecycle listeners", async () => {
    let request!: IncomingMessage, response!: ServerResponse;
    const handler = createLambdaHttpHandler(async (incoming, outgoing) => {
      request = incoming; response = outgoing;
      await new Promise<void>(resolve => setImmediate(resolve));
      response.writeHead(204); response.end();
    });
    const result = await handler(event, {} as never, () => {});
    expect(result.statusCode).toBe(204);
    expect(result.body).toBe("");
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
    expect(request.listenerCount("error")).toBe(0);
    expect(request.socket.remoteAddress).toBe("127.0.0.1");
    expect(request.socket.localAddress).toBeUndefined();
    expect(request.socket.localPort).toBeUndefined();
    expect((request.socket as Socket & { encrypted: boolean }).encrypted).toBe(true);
    let events = 0;
    request.socket.once("synthetic-observation", () => { events++; });
    request.socket.emit("synthetic-observation");
    request.socket.emit("synthetic-observation");
    expect(events).toBe(1);
  });

  it.each(["throw", "reject", "request-error", "response-error", "close", "destroy"] as const)(
    "settles %s failures without a success response or error details in the response", async kind => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      let request!: IncomingMessage, response!: ServerResponse;
      try {
        const handler = createLambdaHttpHandler((incoming, outgoing) => {
          request = incoming; response = outgoing;
          if (kind === "throw") throw new Error("synthetic private failure");
          if (kind === "reject") return Promise.reject(new Error("synthetic private failure"));
          queueMicrotask(() => {
            if (kind === "close") response.emit("close");
            else if (kind === "destroy") response.destroy(new Error("synthetic private failure"));
            else if (kind === "request-error") request.emit("error", new Error("synthetic private failure"));
            else response.emit("error", new Error("synthetic private failure"));
          });
        });
        const result = await handler(event, {} as never, () => {});
        expect(result.statusCode).toBe(500);
        expect(result.body).toBe("");
        expect(response.listenerCount("finish")).toBe(0);
        expect(response.listenerCount("close")).toBe(0);
        expect(response.listenerCount("error")).toBe(0);
        expect(request.listenerCount("error")).toBe(0);
      } finally { logged.mockRestore(); }
    }, 1000,
  );
});

describe("Lambda buffered write compatibility", () => {
  const event = {
    version: "2.0", routeKey: "$default", rawPath: "/", rawQueryString: "",
    headers: { host: "lambda-write.synthetic.test" },
    requestContext: { http: { method: "GET", path: "/", sourceIp: "127.0.0.1" }, stage: "$default" },
    isBase64Encoded: false,
  };

  it.each([true, false, undefined])("preserves an underlying %s write result, normalizing only undefined", async underlying => {
    let actual: boolean | undefined, callbacks = 0, receiverPreserved = false;
    const handler = createLambdaHttpHandler((_request, response) => {
      // Complete the header flush first so the controlled socket result applies
      // to one actual body write, not an implicit header operation.
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
      const socket = response.socket!, original = socket.write;
      socket.write = function (this: Socket, ...args: Parameters<Socket["write"]>) {
        receiverPreserved = this === socket;
        original.apply(this, args);
        return underlying as boolean;
      } as Socket["write"];
      actual = response.write("synthetic-body", "utf8", () => { callbacks++; });
      socket.write = original;
      response.end();
    });
    const result = await handler(event, {} as never, () => {});
    expect(actual).toBe(underlying === undefined ? true : underlying);
    expect(receiverPreserved).toBe(true);
    expect(callbacks).toBe(1);
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("synthetic-body");
  });

  it("propagates a synchronous write error without converting it into accepted data", async () => {
    const failure = new Error("synthetic-write-failure");
    let caught: unknown, callbacks = 0;
    const handler = createLambdaHttpHandler((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
      const socket = response.socket!, original = socket.write;
      socket.write = (() => { throw failure; }) as Socket["write"];
      try { response.write("must-not-be-buffered", () => { callbacks++; }); }
      catch (error) { caught = error; }
      finally { socket.write = original; }
      response.end("recovered-after-test-error");
    });
    const result = await handler(event, {} as never, () => {});
    expect(caught).toBe(failure);
    expect(callbacks).toBe(0);
    expect(result.body).toBe("recovered-after-test-error");
  });

  it.each([
    { kind: "Buffer", chunk: Buffer.from("synthetic-bytes") },
    { kind: "Uint8Array", chunk: new TextEncoder().encode("synthetic-bytes") },
  ])("accepts $kind writes and forwards their completion callback exactly once", async ({ chunk }) => {
    let accepted: boolean | undefined, callbacks = 0;
    const handler = createLambdaHttpHandler((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      accepted = response.write(chunk, () => { callbacks++; });
      response.end();
    });
    const result = await handler(event, {} as never, () => {});
    expect(accepted).toBe(true);
    expect(callbacks).toBe(1);
    expect(result.body).toBe("synthetic-bytes");
  });
});
