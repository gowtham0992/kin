import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const entries = [
  { file: "scripts/preview-invitations.ts", args: (port: number) => ["success", String(port)], ready: "Synthetic invitation preview" },
  { file: "scripts/preview-notifications.ts", args: (port: number) => [String(port)], ready: "Synthetic notification preview" },
  { file: "scripts/run-local-story.ts", args: (_port: number) => [], ready: "Kin local story: http" },
  { file: "src/index.ts", args: (_port: number) => [], ready: "Kin MCP server listening" },
];

describe("local CLI startup", () => {
  it.each(entries)("$file fails without announcing readiness when the port is occupied", async ({ file, args, ready }) => {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback TCP port");
    // Deliberately exclude AWS/config/credential environment variables. All four
    // entry points use their local-only defaults; no cloud operations are enabled.
    const child = spawn(process.execPath, ["--import", "tsx", file, ...args(address.port)], {
      cwd: root, env: { PATH: process.env.PATH, PORT: String(address.port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
    try {
      const [code, signal] = await once(child, "close");
      expect(signal).toBeNull();
      expect(stdout).not.toContain(ready);
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/EADDRINUSE|could not open the local story port/);
    } finally {
      clearTimeout(timeout);
      child.kill();
      await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    }
  }, 10_000);
});
