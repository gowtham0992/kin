import { configure as serverlessExpress } from "@codegenie/serverless-express";
import type { RequestListener, ServerResponse } from "node:http";

export function createLambdaHttpHandler(app: RequestListener) {
  return serverlessExpress({
    app: (request, response) => {
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
    },
  });
}
