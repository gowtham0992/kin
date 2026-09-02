import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TaskNotFoundError, type CareRepository } from "./domain.js";
import { createMcpServer } from "./mcp.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const simulatorDirectory = path.resolve(moduleDirectory, "../simulator");
const confirmationBody = z.object({
  response: z.enum(["done", "not_yet", "skipped"]),
  actor: z.string().trim().min(1).max(80),
  requestId: z.string().min(8).max(100),
}).strict();

export function createHttpApp(store: CareRepository) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));
  app.use(express.static(simulatorDirectory, { extensions: ["html"] }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "kin", version: "0.1.0" });
  });

  app.get("/api/today", async (_request, response, next) => {
    try {
      response.set("cache-control", "no-store").json(await store.today());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tasks/:taskId/confirm", async (request, response, next) => {
    const body = confirmationBody.safeParse(request.body);
    const taskId = z.string().min(1).max(100).safeParse(request.params.taskId);
    if (!body.success || !taskId.success) {
      response.status(400).json({ error: "Invalid confirmation request" });
      return;
    }

    try {
      const result = await store.confirm({ taskId: taskId.data, ...body.data });
      response.status(result.replayed ? 200 : 201).json({
        ...result,
        snapshot: await store.today(),
      });
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        response.status(404).json({ error: "Care task not found" });
        return;
      }
      next(error);
    }
  });

  app.post("/mcp", async (request, response) => {
    const server = createMcpServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_request, response) => {
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  app.delete("/mcp", (_request, response) => {
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 413
    ) {
      response.status(413).json({ error: "Request body too large" });
      return;
    }
    response.status(500).json({ error: "Internal server error" });
  });

  return app;
}
