// Local synthetic UI fixture only. No AWS clients, persisted data, or live accounts.
import express from "express";
import { createHttpApp } from "../src/http.js";
import { createDemoStore } from "../src/domain.js";

const mode = process.argv[2] ?? "success";
const port = Number(process.argv[3] ?? 3014);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid preview port");
if (!["success", "denied", "empty", "conflict", "uncertain"].includes(mode)) throw new Error("Unknown fixture mode");
const app = express();
app.use((_request, response, next) => { response.set("cache-control", "no-store"); next(); });
const store = createDemoStore();
if (mode === "empty") store.circle = async () => ({ startDate: "2026-09-05", endDate: "2026-09-11", members: [], assignments: [] });
app.use(createHttpApp(store, undefined, {
  accessAuthorizer: { async authorize() { return { subject: "synthetic-organizer", scopes: new Set(["mcp:tools"]), claims: { iss: "https://example.invalid" } }; } },
  familyAccess: { circleId: "synthetic", directory: { async find() { return {
    circleId: "synthetic", memberId: "maya", name: "Maya", role: "caregiver", status: "active", canInvite: mode !== "denied",
  }; } } },
  invitationIssuer: { async issue(_principal, input) {
    if (mode === "conflict") {
      const { InvitationIssueError } = await import("../src/invitation-issuer.js");
      throw new InvitationIssueError();
    }
    if (mode === "uncertain") throw new Error("Synthetic unavailable service");
    return { code: "synthetic-preview-not-a-real-invitation-code!".replace(/!/g, "x").padEnd(43, "x").slice(0, 43),
      expiresAt: Math.floor(Date.now() / 1000) + 86400, memberId: input.memberId, role: input.role };
  } },
}));
const server = app.listen(port, "127.0.0.1", () => console.log(`Synthetic invitation preview (${mode}): http://127.0.0.1:${port}/invite.html`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
