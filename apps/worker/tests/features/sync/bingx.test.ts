import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { syncExchange } from "@taiwan-fin-hub/connectors";
import { privateClient } from "../../../../../packages/connectors/src/exchanges/http";
const now = Date.parse("2026-10-22T00:00:00Z");
const config = { apiKey: "synthetic-key", apiSecret: "synthetic-secret" };
function fixture(permissions: (number | string)[] = [2]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.searchParams.has("signature")) {
      const signature = url.searchParams.get("signature");
      url.searchParams.delete("signature");
      expect(signature).toBe(
        createHmac("sha256", config.apiSecret)
          .update(url.searchParams.toString())
          .digest("hex"),
      );
      expect(new Headers(init?.headers).get("X-BX-APIKEY")).toBe(config.apiKey);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
    } else expect(new Headers(init?.headers).has("X-BX-APIKEY")).toBe(false);
    const rows: Record<string, unknown> = {
      "/openApi/v1/account/apiPermissions": { permissions },
      "/openApi/spot/v1/account/balance": {
        code: 0,
        data: {
          balances: [
            { asset: "BTC", free: "1", locked: "0.25" },
            { asset: "VST", free: "10000", locked: "0" },
          ],
        },
      },
      "/openApi/fund/v1/account/balance": {
        code: 0,
        data: { balances: [{ asset: "USDT", free: "8", locked: "2" }] },
      },
      "/openApi/spot/v2/quote/price": {
        code: 0,
        data: [{ symbol: "BTC-USDT", price: "100" }],
      },
      "/v2/prices/USDT-USD/spot": {
        data: { base: "USDT", currency: "USD", amount: "0.98" },
      },
      "/v6/latest/TWD": {
        result: "success",
        base_code: "TWD",
        rates: { USD: 0.03125 },
        time_last_update_unix: now / 1000,
      },
    };
    if (!(url.pathname in rows)) throw new Error("Unexpected endpoint");
    return new Response(JSON.stringify(rows[url.pathname]));
  }) as unknown as typeof fetch;
}
describe("BingX readonly assets", () => {
  it("signs balance reads and values separate spot/fund wallets without demo currency", async () => {
    const result = await syncExchange("bingx", config, {
      fetcher: fixture(),
      now: () => now,
    });
    expect(result.bankBalanceSnapshots?.[0].balance).toBeCloseTo(
      135 * 0.98 * 32,
    );
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
    expect(JSON.stringify(result)).not.toContain(config.apiSecret);
  });
  it.each([[1, 2], [2, 3], [2, 4], [2, 5], [2, 7], [2, 999], []])(
    "rejects unsafe/unknown permissions %j",
    async (...permissions) => {
      await expect(
        syncExchange("bingx", config, {
          fetcher: fixture(permissions),
          now: () => now,
        }),
      ).rejects.toThrow();
    },
  );
  it("rejects all non-allowlisted operations before any request", async () => {
    const fetcher = vi.fn();
    const request = privateClient("bingx", config, fetcher, () => now);
    await expect(request("/openApi/api/asset/v1/transfer")).rejects.toThrow(
      "不允許",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects failed funding response without exposing the upstream body", async () => {
    const base = fixture();
    const fetcher: typeof fetch = async (input, init) =>
      String(input).includes("/fund/")
        ? new Response(JSON.stringify({ code: 100001, msg: config.apiSecret }))
        : base(input, init);
    const promise = syncExchange("bingx", config, { fetcher, now: () => now });
    await expect(promise).rejects.toThrow("未更新資產");
    await expect(promise).rejects.not.toThrow(config.apiSecret);
  });
});

describe("BingX permission representations and safe diagnostics", () => {
  it("accepts the read-only string permission without relaxing permission checks", async () => {
    const result = await syncExchange("bingx", config, {
      fetcher: fixture(["2"]),
      now: () => now,
    });
    expect(result.bankBalanceSnapshots?.[0].balance).toBeCloseTo(
      135 * 0.98 * 32,
    );
  });
  it("rejects string write permissions", async () => {
    await expect(
      syncExchange("bingx", config, {
        fetcher: fixture(["2", "5"]),
        now: () => now,
      }),
    ).rejects.toThrow("只有讀取");
  });
  it("identifies bank-side codes without disclosing their message", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ code: 100001, msg: config.apiSecret }));
    const result = syncExchange("bingx", config, { fetcher, now: () => now });
    await expect(result).rejects.toThrow("API Key 權限檢查失敗（代碼 100001）");
    await expect(result).rejects.not.toThrow(config.apiSecret);
  });
  it("reports the failing schema stage without printing its fields", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({ code: 0, data: { secret: config.apiSecret } }),
      );
    const result = syncExchange("bingx", config, { fetcher, now: () => now });
    await expect(result).rejects.toThrow("API Key 權限檢查回應格式不符");
    await expect(result).rejects.not.toThrow(config.apiSecret);
  });
});

describe("BingX observed funding response", () => {
  it("accepts data.assets with numeric amounts and includes locked funds", async () => {
    const base = fixture();
    const fetcher: typeof fetch = async (input, init) =>
      String(input).includes("/fund/")
        ? new Response(
            JSON.stringify({
              code: 0,
              data: { assets: [{ asset: "USDT", free: 8, locked: 2 }] },
            }),
          )
        : base(input, init);
    const result = await syncExchange("bingx", config, {
      fetcher,
      now: () => now,
    });
    expect(result.bankBalanceSnapshots?.[0].balance).toBeCloseTo(
      135 * 0.98 * 32,
    );
  });
  it.each([
    null,
    {},
    { assets: [{ asset: "USDT", free: -1, locked: 0 }] },
    { assets: [{ asset: "USDT", free: 8 }] },
  ])("does not turn missing or invalid funds into zero", async (data) => {
    const base = fixture();
    const fetcher: typeof fetch = async (input, init) =>
      String(input).includes("/fund/")
        ? new Response(JSON.stringify({ code: 0, data }))
        : base(input, init);
    await expect(
      syncExchange("bingx", config, { fetcher, now: () => now }),
    ).rejects.toThrow("資金帳戶查詢回應格式不符");
  });
});
