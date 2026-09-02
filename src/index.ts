import { createDemoStore } from "./domain.js";
import { createDynamoCareRepository } from "./dynamo-care-repository.js";
import { createHttpApp } from "./http.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const tableName = process.env.KIN_DYNAMODB_TABLE?.trim();
const circleId = process.env.KIN_CIRCLE_ID?.trim() || "demo-family";
const repository = tableName
  ? createDynamoCareRepository({
      tableName,
      circleId,
      region: process.env.AWS_REGION,
    })
  : createDemoStore();

const app = createHttpApp(repository);
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Kin MCP server listening at http://127.0.0.1:${port}/mcp`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
