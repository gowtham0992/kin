import { Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { expect, it } from "vitest";

it("binds automatic HTTP test servers to the loopback address their clients use", async () => {
  const probe = request((_request: IncomingMessage, response: ServerResponse) => {
    response.end("intended test application");
  }).get("/loopback");
  expect(probe.app).toBeInstanceOf(Server);
  const server = probe.app as Server;
  let address: AddressInfo | undefined;
  server.once("listening", () => { address = server.address() as AddressInfo; });

  try {
    await probe.expect(200, "intended test application");
    // On macOS a wildcard listener can share a port with another process's
    // IPv4 listener. Supertest must bind the same address it connects to:
    // https://github.com/forwardemail/supertest/pull/907
    expect(new URL(probe.url).hostname).toBe("127.0.0.1");
    expect(address).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});
