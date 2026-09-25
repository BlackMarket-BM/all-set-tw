import { describe, expect, it } from "vitest";
import { encryptJson, decryptJson } from "../../src/platform/crypto";
import { safeLogError } from "../../src/platform/safe-log";
import { safeErrorMessage } from "../../src/features/sync/service";

describe("security audit regression checks (synthetic data only)", () => {
  it("omits arbitrary error messages, stacks, causes and custom properties", () => {
    const error = Object.assign(new Error("synthetic-private-value"), {
      cause: new Error("synthetic-private-value"),
      request: { password: "synthetic-private-value" },
    });
    error.stack = "synthetic-private-value";
    const safe = safeLogError(error);
    expect(JSON.stringify(safe)).not.toContain("synthetic-private-value");
    expect(String(safe.stack)).not.toContain("synthetic-private-value");
    expect(safe.cause).toBeUndefined();
  });

  it("redacts short and quoted authentication fields from persisted errors", () => {
    for (const key of [
      "otp",
      "accessToken",
      "refreshToken",
      "deviceToken",
      "sessionId",
      "apiKey",
      "password",
    ]) {
      const result = safeErrorMessage(
        new Error(JSON.stringify({ [key]: "short-test-value" })),
      );
      expect(result).not.toContain("short-test-value");
    }
    expect(
      safeErrorMessage(
        new Error("Cookie: a=short-test-value; b=second-test-value"),
      ),
    ).not.toContain("test-value");
  });

  it("uses fresh nonces and rejects wrong keys and modified ciphertext", async () => {
    const value = { password: "synthetic-private-value" };
    const first = await encryptJson(value, "synthetic-audit-key");
    const second = await encryptJson(value, "synthetic-audit-key");
    expect(JSON.parse(first).iv).not.toBe(JSON.parse(second).iv);
    expect(await decryptJson(first, "synthetic-audit-key")).toEqual(value);
    await expect(decryptJson(first, "different-test-key")).rejects.toThrow();
    const envelope = JSON.parse(first);
    envelope.ciphertext =
      (envelope.ciphertext[0] === "A" ? "B" : "A") +
      envelope.ciphertext.slice(1);
    await expect(
      decryptJson(JSON.stringify(envelope), "synthetic-audit-key"),
    ).rejects.toThrow();
  });
});
