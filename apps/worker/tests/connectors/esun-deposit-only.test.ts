import { describe, expect, it, vi } from "vitest";
import {
  collectEsunBrowserSnapshot,
  collectEsunSnapshot,
  type EsunPortalApi,
} from "../../src/connectors/esun-portal";

function response(path: string) {
  if (path.includes("preQueryTW"))
    return {
      resultCode: "0000",
      resultBody: {
        demandDeptAcc: "synthetic-account",
        twCurrInfo: { realBalance: 123 },
        twAccountList: [],
      },
    };
  return { resultCode: "0000", resultBody: {} };
}

describe("E.SUN deposit-only mode", () => {
  it("collects deposits without opening the card site or requiring a card token", async () => {
    const portalPage = {
      waitForFunction: vi.fn(),
      evaluate: vi.fn(async (_fn: unknown, path?: string) =>
        path ? response(path) : "synthetic-portal-session",
      ),
      cookies: vi.fn(async () => []),
    };
    const browser = {
      pages: vi.fn(() => {
        throw new Error("Must not open cards");
      }),
    };
    const result = await collectEsunBrowserSnapshot(
      browser as never,
      portalPage as never,
      false,
    );
    expect(browser.pages).not.toHaveBeenCalled();
    expect(result.snapshot.twDeposits).toEqual([
      expect.objectContaining({ currency: "TWD", balance: 123 }),
    ]);
    expect(result.snapshot.creditHistory).toEqual([]);
    expect(result.snapshot.cardOverview).toBeNull();
    expect(result.session.iescAccessToken).toBe("");
    for (const call of portalPage.evaluate.mock.calls)
      if (call[1]) expect(call[1]).toContain("mib-ctw-portal/");
  });
  it("reuses a deposit-only session without calling any card API", async () => {
    const api: EsunPortalApi = {
      postPortal: vi.fn(async (path) => response(path)),
      postIesc: vi.fn(),
      readRealtime: vi.fn(),
    };
    const result = await collectEsunSnapshot(api, false);
    expect(result.twDeposits[0]?.balance).toBe(123);
    expect(api.postIesc).not.toHaveBeenCalled();
    expect(api.readRealtime).not.toHaveBeenCalled();
  });
  it("keeps full sync as default and does not silently ignore card failures", async () => {
    const api: EsunPortalApi = {
      postPortal: vi.fn(),
      postIesc: vi.fn(),
      readRealtime: vi.fn().mockRejectedValue(new Error("card unavailable")),
    };
    await expect(collectEsunSnapshot(api)).rejects.toThrow("card unavailable");
    expect(api.postPortal).not.toHaveBeenCalled();
  });
});
