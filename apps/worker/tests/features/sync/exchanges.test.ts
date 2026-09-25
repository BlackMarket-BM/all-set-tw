import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { syncExchange } from "@taiwan-fin-hub/connectors";
import {
  hmac,
  jsonRequest,
  privateClient,
  type ExchangeId,
} from "../../../../../packages/connectors/src/exchanges/http";
import { decryptJson, encryptJson } from "../../../src/platform/crypto";

const timestamp = Date.parse("2026-09-23T00:00:00Z");
const config = {
  apiKey: "key-private",
  apiSecret: "secret-private",
  passphrase: "pass-private",
};
const permissions = {
  enableReading: true,
  enableWithdrawals: false,
  enableInternalTransfer: false,
  enableMargin: false,
  enableFutures: false,
  permitsUniversalTransfer: false,
  enableVanillaOptions: false,
  enableSpotAndMarginTrading: false,
};
function fixtures(): Record<string, unknown> {
  return {
    "/sapi/v1/account/apiRestrictions": permissions,
    "/api/v3/account": {
      balances: [{ asset: "BTC", free: "1", locked: "0.25" }],
    },
    "/sapi/v1/asset/get-funding-asset": [
      { asset: "USDT", free: "2", locked: "3", freeze: "4", withdrawing: "1" },
    ],
    "/api/v3/ticker/price": [{ symbol: "BTCUSDT", price: "100" }],
    "/v5/user/query-api": { retCode: 0, result: { readOnly: 1 } },
    "/v5/account/wallet-balance": {
      retCode: 0,
      result: {
        list: [
          {
            accountType: "UNIFIED",
            totalEquity: "150",
            coin: [{ usdValue: "99999" }],
          },
        ],
      },
    },
    "/v5/asset/transfer/query-account-coins-balance": {
      retCode: 0,
      result: {
        accountType: "FUND",
        balance: [{ coin: "USDT", walletBalance: "10" }],
      },
    },
    "/v5/market/tickers": { retCode: 0, result: { list: [] } },
    "/api/v5/account/config": { code: "0", data: [{ perm: "read_only" }] },
    "/api/v5/account/balance": {
      code: "0",
      data: [{ details: [{ ccy: "BTC", cashBal: "1.25", liab: "0" }] }],
    },
    "/api/v5/asset/balances": { code: "0", data: [{ ccy: "USDT", bal: "10" }] },
    "/api/v5/market/tickers": {
      code: "0",
      data: [{ instId: "BTC-USDT", last: "100" }],
    },
    "/v2/prices/USDT-USD/spot": {
      data: { base: "USDT", currency: "USD", amount: "0.98" },
    },
    "/v6/latest/TWD": {
      result: "success",
      base_code: "TWD",
      rates: { USD: 0.03125 },
      time_last_update_unix: timestamp / 1000,
    },
  };
}
function fetchMock(values: Record<string, unknown>) {
  return vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (!(path in values)) throw new Error("Unexpected request");
    return Response.json(values[path]);
  });
}
describe("唯讀交易所資產", () => {
  it.each([
    [
      "https://api-gcp.binance.com/sapi/v1/account/apiRestrictions?signature=secret-private",
      "Binance API Key 權限檢查",
    ],
    [
      "https://api.coinbase.com/v2/prices/USDT-USD/spot",
      "Coinbase USDT/USD 價格查詢",
    ],
    ["https://open.er-api.com/v6/latest/TWD", "USD/TWD 匯率查詢"],
    ["https://secret-private.invalid/key-private", "交易所／價格服務"],
  ])(
    "identifies failure stage without exposing URL or response for %s",
    async (url, label) => {
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response("key-private secret-private", { status: 451 }),
      );
      const failure = await jsonRequest(fetcher, url).catch(
        (error: Error) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(`${label} HTTP 451`);
      expect((failure as Error).message).not.toMatch(
        /key-private|secret-private|https:/,
      );
    },
  );
  it.each([301, 302, 307, 308])(
    "rejects redirect %s without forwarding credentials",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response("secret-private", {
            status,
            headers: { location: "https://untrusted.invalid" },
          }),
      );
      await expect(
        jsonRequest(fetcher, "https://api-gcp.binance.com/private", {
          headers: { "X-MBX-APIKEY": config.apiKey },
        }),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1]?.redirect).toBe("manual");
    },
  );
  it("values Bitfinex wallet totals, signs POST bodies with SHA384 and advances nonces", async () => {
    const fetcher = fetchMock({
      ...fixtures(),
      "/v2/auth/r/permissions": [
        ["wallets", 1, 0],
        ["orders", 0, 0],
      ],
      "/v2/auth/r/wallets": [
        ["exchange", "BTC", 1.25, 0, 0.25],
        ["funding", "UST", 10, 2, 3],
        ["funding", "USD", 20, 1, null],
        ["margin", "BTC", 1000, 0, 1000],
      ],
      "/v2/tickers": [
        ["tBTCUSD", 99, 1, 101, 1, 0, 0, 100, 1, 101, 99],
        ["fUSD", 0],
      ],
    });
    const result = await syncExchange("bitfinex", config, {
      fetcher,
      now: () => timestamp,
    });
    expect(result.bankBalanceSnapshots?.[0].balance).toBeCloseTo(
      (125 + 9.8 + 20) * 32,
    );
    expect(result.bankBalanceSnapshots?.[0].raw).toMatchObject({
      holdings: [
        expect.objectContaining({ asset: "BTC" }),
        expect.objectContaining({ asset: "USDT" }),
        expect.objectContaining({ asset: "USD" }),
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /key-private|secret-private|pass-private/,
    );
    const nonces: number[] = [];
    for (const [url, init] of fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      if (!headers.has("bfx-apikey")) continue;
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe("{}");
      expect(headers.get("bfx-signature")).toBe(
        createHmac("sha384", config.apiSecret)
          .update(
            `/api${new URL(String(url)).pathname}${headers.get("bfx-nonce")}${init?.body}`,
          )
          .digest("hex"),
      );
      nonces.push(Number(headers.get("bfx-nonce")));
    }
    expect(nonces).toEqual([timestamp * 1000, timestamp * 1000 + 1]);
  });
  it.each([
    [["wallets", 1, 1]],
    [
      ["wallets", 1, 0],
      ["unknown_future_scope", 1, 1],
    ],
    [["wallets", 0, 0]],
    [],
  ])(
    "rejects unsafe or incomplete Bitfinex permissions %j",
    async (...permissions) => {
      const fetcher = fetchMock({ "/v2/auth/r/permissions": permissions });
      await expect(
        syncExchange("bitfinex", config, { fetcher }),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["missing", "malformed", "error", "zero", "colon"])(
    "handles Bitfinex %s without partial valuation",
    async (scenario) => {
      const data = {
        ...fixtures(),
        "/v2/auth/r/permissions": [["wallets", 1, 0]],
        "/v2/auth/r/wallets": [["exchange", "LONGTOKEN", 2, 0, null]],
        "/v2/tickers": [["tLONGTOKEN:UST", 0, 0, 0, 0, 0, 0, 5]],
      } as Record<string, unknown>;
      if (scenario === "missing") data["/v2/tickers"] = [];
      if (scenario === "malformed")
        data["/v2/auth/r/wallets"] = [["exchange", "BTC", "bad"]];
      if (scenario === "error")
        data["/v2/auth/r/wallets"] = ["error", 10114, "secret-private"];
      if (scenario === "zero") data["/v2/auth/r/wallets"] = [];
      const promise = syncExchange("bitfinex", config, {
        fetcher: fetchMock(data),
        now: () => timestamp,
      });
      if (scenario === "zero" || scenario === "colon")
        expect((await promise).bankBalanceSnapshots?.[0].balance).toBeCloseTo(
          scenario === "zero" ? 0 : 2 * 5 * 0.98 * 32,
        );
      else await expect(promise).rejects.toThrow();
    },
  );
  it("signs HMAC SHA256 against an independent implementation", async () => {
    for (const encoding of ["hex", "base64"] as const)
      expect(await hmac("secret", "timestampGET/path?a=1", encoding)).toBe(
        createHmac("sha256", "secret")
          .update("timestampGET/path?a=1")
          .digest(encoding),
      );
  });
  it.each(["binance", "bybit", "okx"] as const)(
    "%s signs the exact requested query and never calls a write endpoint",
    async (id) => {
      const fetcher = fetchMock(fixtures());
      const result = await syncExchange(id, config, {
        fetcher,
        now: () => timestamp,
      });
      expect(result.bankBalanceSnapshots?.[0].balance).toBeCloseTo(
        id === "bybit" ? (150 + 10 * 0.98) * 32 : 135 * 0.98 * 32,
      );
      expect(JSON.stringify(result)).not.toMatch(
        /key-private|secret-private|pass-private/,
      );
      for (const [input, init] of fetcher.mock.calls) {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        expect(init?.redirect).toBe("manual");
        if (headers.has("X-MBX-APIKEY")) {
          const signature = url.searchParams.get("signature");
          url.searchParams.delete("signature");
          expect(signature).toBe(
            createHmac("sha256", config.apiSecret)
              .update(url.searchParams.toString())
              .digest("hex"),
          );
          expect(init?.method).toBe(
            url.pathname.endsWith("get-funding-asset") ? "POST" : "GET",
          );
        } else if (headers.has("X-BAPI-SIGN")) {
          expect(headers.get("X-BAPI-SIGN")).toBe(
            createHmac("sha256", config.apiSecret)
              .update(
                String(timestamp) +
                  config.apiKey +
                  "5000" +
                  url.searchParams.toString(),
              )
              .digest("hex"),
          );
        } else if (headers.has("OK-ACCESS-SIGN")) {
          expect(headers.get("OK-ACCESS-SIGN")).toBe(
            createHmac("sha256", config.apiSecret)
              .update(
                new Date(timestamp).toISOString() +
                  "GET" +
                  url.pathname +
                  url.search,
              )
              .digest("base64"),
          );
        }
      }
    },
  );
  it.each(["binance", "bybit", "okx"] as const)(
    "%s refuses non-read-only credentials before fetching balances",
    async (id) => {
      const data = fixtures();
      data["/sapi/v1/account/apiRestrictions"] = {
        ...permissions,
        enableWithdrawals: true,
      };
      data["/v5/user/query-api"] = { retCode: 0, result: { readOnly: 0 } };
      data["/api/v5/account/config"] = {
        code: "0",
        data: [{ perm: "read_only,trade" }],
      };
      const fetcher = fetchMock(data);
      await expect(
        syncExchange(id, config, { fetcher, now: () => timestamp }),
      ).rejects.toThrow("只有讀取權限");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects arbitrary private endpoints", async () => {
    const fetcher = fetchMock({});
    await expect(
      privateClient(
        "binance",
        config,
        fetcher,
        () => timestamp,
      )("/sapi/v1/capital/withdraw/apply"),
    ).rejects.toThrow("不允許");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["missing-price", "stale-fx", "invalid-balance", "business-error"])(
    "does not return a partial valuation for %s",
    async (scenario) => {
      const data = fixtures();
      if (scenario === "missing-price") data["/api/v3/ticker/price"] = [];
      if (scenario === "stale-fx")
        data["/v6/latest/TWD"] = {
          result: "success",
          base_code: "TWD",
          rates: { USD: 0.03125 },
          time_last_update_unix: timestamp / 1000 - 4 * 86400,
        };
      if (scenario === "invalid-balance")
        data["/api/v3/account"] = {
          balances: [{ asset: "BTC", free: "NaN", locked: "0" }],
        };
      if (scenario === "business-error")
        data["/api/v3/account"] = { code: -2015, msg: "secret-private" };
      await expect(
        syncExchange("binance", config, {
          fetcher: fetchMock(data),
          now: () => timestamp,
        }),
      ).rejects.toThrow();
    },
  );
  it("replaces a sold-out portfolio with an explicit zero snapshot and stable identity", async () => {
    const data = fixtures();
    const options = { fetcher: fetchMock(data), now: () => timestamp };
    const before = await syncExchange("binance", config, options);
    data["/api/v3/account"] = { balances: [] };
    data["/sapi/v1/asset/get-funding-asset"] = [];
    const after = await syncExchange("binance", config, {
      ...options,
      now: () => timestamp + 1000,
    });
    expect(after.bankAccounts).toEqual(before.bankAccounts);
    expect(after.bankBalanceSnapshots?.[0].balance).toBe(0);
  });
  it("keeps errors free of upstream credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("secret-private key-private");
    });
    await expect(syncExchange("bybit", config, { fetcher })).rejects.toThrow(
      "無法連線",
    );
  });
  it("encrypts every credential with random IVs and rejects the wrong key", async () => {
    const first = await encryptJson(config, "master-key");
    expect(first).not.toContain(config.apiSecret);
    expect(first).not.toContain(config.apiKey);
    expect(first).not.toBe(await encryptJson(config, "master-key"));
    expect(await decryptJson(first, "master-key")).toEqual(config);
    await expect(decryptJson(first, "wrong-key")).rejects.toThrow();
  });
});
