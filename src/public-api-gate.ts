import express from "express";

export function createUnavailablePublicApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Retry-After", "60");
    response.status(503).json({ error: "Kin's public API is temporarily unavailable" });
  });
  return app;
}
