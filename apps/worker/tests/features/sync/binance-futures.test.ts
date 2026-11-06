import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { syncExchange } from "@taiwan-fin-hub/connectors";
const now = Date.parse("2026-11-06T00:00:00Z");
const config = { apiKey: "synthetic-key", apiSecret: "synthetic-secret" };
function fixtures(): Record<string, unknown> {
  return {
    "/sapi/v1/account/apiRestrictions": {
      enableReading: true,
      enableWithdrawals: false,
      enableInternalTransfer: false,
      enableMargin: false,
      enableFutures: false,
      permitsUniversalTransfer: false,
      enableVanillaOptions: false,
      enableSpotAndMarginTrading: false,
    },
    "/api/v3/account": {
      balances: [{ asset: "USDT", free: "10", locked: "0" }],
    },
    "/sapi/v1/asset/get-funding-asset": [
      { asset: "USDT", free: "20", locked: "0", freeze: "0", withdrawing: "0" },
    ],
    "/sapi/v1/asset/wallet/balance": [
      { walletName: "Spot", activate: true, balance: "999999" },
      { walletName: "Funding", activate: true, balance: "999999" },
      { walletName: "USDⓈ-M Futures", activate: true, balance: "90" },
      { walletName: "COIN-M Futures", activate: true, balance: "200" },
      { walletName: "Earn", activate: true, balance: "999999" },
    ],
    "/api/v3/ticker/price": [{ symbol: "BTCUSDT", price: "100" }],
    "/v2/prices/USDT-USD/spot": {
      data: { base: "USDT", currency: "USD", amount: "0.98" },
    },
    "/v6/latest/TWD": {
      result: "success",
      base_code: "TWD",
      time_last_update_unix: now / 1000,
      rates: { USD: 0.03125 },
    },
  };
}
function mock(data: Record<string, unknown>) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const u = new URL(String(input));
    if (new Headers(init?.headers).has("X-MBX-APIKEY")) {
      expect(u.origin).toBe("https://api-gcp.binance.com");
      if (u.pathname === "/sapi/v1/asset/wallet/balance")
        expect(u.searchParams.get("quoteAsset")).toBe("USDT");
      const signature = u.searchParams.get("signature");
      u.searchParams.delete("signature");
      expect(signature).toBe(
        createHmac("sha256", config.apiSecret)
          .update(u.searchParams.toString())
          .digest("hex"),
      );
      expect(init?.method).toBe(
        u.pathname.includes("get-funding-asset") ? "POST" : "GET",
      );
    }
    if (!(u.pathname in data)) throw new Error("Unexpected endpoint");
    return Response.json(data[u.pathname]);
  });
}
describe("Binance futures asset equity", () => {
  it("values only USD-M and COIN-M wallet overview once without other wallets", async () => {
    const result = await syncExchange("binance", config, {
      fetcher: mock(fixtures()),
      now: () => now,
    });
    expect(result.bankBalanceSnapshots?.[0].balance).toBeCloseTo(
      320 * 0.98 * 32,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-key|synthetic-secret/,
    );
  });
  it("preserves negative futures equity", async () => {
    const data = fixtures();
    data["/sapi/v1/asset/wallet/balance"] = [
      { walletName: "USDⓈ-M Futures", activate: true, balance: "-40" },
      { walletName: "COIN-M Futures", activate: false, balance: "0" },
    ];
    const result = await syncExchange("binance", config, {
      fetcher: mock(data),
      now: () => now,
    });
    expect(result.bankBalanceSnapshots?.[0].balance).toBeCloseTo(
      -10 * 0.98 * 32,
    );
  });
  it.each([
    {},
    [],
    [{ walletName: "USDⓈ-M Futures", activate: true, balance: "2" }],
    [
      { walletName: "USDⓈ-M Futures", activate: true, balance: "NaN" },
      { walletName: "COIN-M Futures", activate: false, balance: "0" },
    ],
    [
      { walletName: "USDⓈ-M Futures", activate: true, balance: "2" },
      { walletName: "USDⓈ-M Futures", activate: true, balance: "2" },
    ],
    [
      { walletName: "USDⓈ-M Futures", activate: true, balance: "2" },
      { walletName: "COIN-M Futures", activate: false, balance: "1" },
    ],
    { code: -2015, msg: "synthetic-secret" },
  ])(
    "does not return a partial valuation for incomplete futures overview",
    async (invalid) => {
      const data = fixtures();
      data["/sapi/v1/asset/wallet/balance"] = invalid;
      const result = syncExchange("binance", config, {
        fetcher: mock(data),
        now: () => now,
      });
      await expect(result).rejects.toThrow("合約錢包總覽");
      await expect(result).rejects.not.toThrow(config.apiSecret);
    },
  );

  it.each([
    "enableFutures",
    "enableWithdrawals",
    "enablePortfolioMarginTrading",
  ])("rejects unsafe permission %s", async (permission) => {
    const data = fixtures();
    data["/sapi/v1/account/apiRestrictions"] = {
      ...(data["/sapi/v1/account/apiRestrictions"] as object),
      [permission]: true,
    };
    const fetcher = mock(data);
    await expect(
      syncExchange("binance", config, { fetcher, now: () => now }),
    ).rejects.toThrow("只有讀取");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not leak upstream errors or return partial assets", async () => {
    const base = mock(fixtures());
    const fetcher: typeof fetch = async (input, init) =>
      String(input).includes("/sapi/v1/asset/wallet/balance")
        ? new Response(config.apiSecret, { status: 403 })
        : base(input, init);
    const result = syncExchange("binance", config, { fetcher, now: () => now });
    await expect(result).rejects.toThrow("HTTP 403");
    await expect(result).rejects.not.toThrow(config.apiSecret);
  });
});
