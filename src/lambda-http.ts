import { configure as serverlessExpress } from "@codegenie/serverless-express";
import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

export function createLambdaHttpHandler(app: RequestListener) {
  const application: RequestListener = (request, response) => {
    const write = response.write;
    // The adapter's synchronous virtual socket can return undefined after
    // buffering a chunk. Hono treats that as backpressure and waits for a
    // drain event the virtual socket never emits. Preserve real false/error
    // results; only normalize the adapter's missing success return value.
    response.write = function (this: ServerResponse, ...args) {
      const accepted = write.apply(this, args as Parameters<ServerResponse["write"]>);
      return accepted === undefined ? true : accepted;
    } as ServerResponse["write"];
    const writeHead = response.writeHead;
    // The adapter captures getHeaders(), whereas the MCP SDK writes headers
    // directly through writeHead(). Stage every header before serialization.
    response.writeHead = function (this: ServerResponse, status, reasonOrHeaders, suppliedHeaders) {
      const headers = typeof reasonOrHeaders === "string" ? suppliedHeaders : reasonOrHeaders;
      if (Array.isArray(headers)) {
        const values = new Map<string, string[]>();
        for (let index = 0; index < headers.length; index += 2) {
          const name = String(headers[index]).toLowerCase();
          const existing = values.get(name) ?? [];
          existing.push(String(headers[index + 1]));
          values.set(name, existing);
        }
        for (const [name, value] of values) {
          this.setHeader(name, name === "set-cookie" || value.length > 1 ? value : value[0]!);
        }
      } else if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          if (value !== undefined) this.setHeader(name, value);
        }
      }
      if (typeof reasonOrHeaders === "string") this.statusMessage = reasonOrHeaders;
      return writeHead.call(this, status);
    } as ServerResponse["writeHead"];
    return app(request, response);
  };
  return serverlessExpress({
    app: application,
    respondWithErrors: false,
    framework: { sendRequest: ({ request, response }: { request: IncomingMessage; response: ServerResponse }) => {
      // Express's final handler drains unmatched requests and observes socket
      // events. The adapter supplies a plain virtual socket; add event support
      // without inventing a local address/port or replacing any real socket.
      if (typeof request.socket.on !== "function") {
        request.socket = Object.assign(new EventEmitter(), request.socket);
      }
      // The default bridge marks the request unreadable when Express returns,
      // before deferred pre-parser middleware has consumed its buffered body.
      // Wait for the response lifecycle instead; never fake readable state.
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const destroy = response.destroy;
        const cleanup = () => {
          request.off("error", failed);
          response.off("error", failed);
          response.off("finish", finished);
          response.off("close", closed);
          response.destroy = destroy;
        };
        const finished = () => {
          if (settled) return;
          settled = true; cleanup(); resolve();
        };
        const failed = (error: unknown) => {
          if (settled) return;
          settled = true; cleanup(); reject(error);
        };
        const closed = () => {
          if (response.writableFinished) finished();
          else failed(new Error("HTTP response closed before completion"));
        };
        request.once("error", failed);
        response.once("error", failed);
        response.once("finish", finished);
        response.once("close", closed);
        // This adapter's virtual socket.destroy() emits no close/error event.
        // Preserve Node's destroy behavior, but settle this buffered invocation.
        response.destroy = function (this: ServerResponse, error?: Error) {
          const result = destroy.call(this, error);
          if (this === response) closed();
          return result;
        };
        try { void Promise.resolve(application(request, response)).catch(failed); }
        catch (error) { failed(error); }
      });
    } },
  });
}
