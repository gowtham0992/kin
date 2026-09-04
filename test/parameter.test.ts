import { describe, expect, it, vi } from "vitest";
import { createStringParameterProvider } from "../src/parameter.js";

describe("SSM string parameter provider", () => {
  it("loads and caches the generated canonical URI", async () => {
    const send = vi.fn(async () => ({
      Parameter: { Value: "https://abc.execute-api.us-east-1.amazonaws.com/mcp" },
    }));
    const provide = createStringParameterProvider({
      parameterName: "/kin/mcp/canonical-uri",
      client: { send },
    });

    await expect(provide()).resolves.toBe(
      "https://abc.execute-api.us-east-1.amazonaws.com/mcp",
    );
    await expect(provide()).resolves.toContain("execute-api");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("temporary SSM failure"))
      .mockResolvedValueOnce({ Parameter: { Value: "https://api.example/mcp" } });
    const provide = createStringParameterProvider({
      parameterName: "/kin/mcp/canonical-uri",
      client: { send },
    });

    await expect(provide()).rejects.toThrow("temporary SSM failure");
    await expect(provide()).resolves.toBe("https://api.example/mcp");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
