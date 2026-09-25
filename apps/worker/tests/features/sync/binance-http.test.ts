import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardBinanceRequest } from "../../../src/connectors/binance-http";
import { exchangeFetch } from "../../../src/connectors/exchange-fetch";

afterEach(() => vi.unstubAllGlobals());

describe("private Binance regional HTTP service", () => {
  it.each([
    ["GET", "/sapi/v1/account/apiRestrictions"],
    ["GET", "/api/v3/account"],
    ["POST", "/sapi/v1/asset/get-funding-asset"],
    ["GET", "/api/v3/ticker/price"],
  ])("preserves signed query for %s %s", async (method, path) => {
    const url = `https://api-gcp.binance.com${path}?timestamp=123&signature=abc%2Fdef`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));
    const result = await forwardBinanceRequest(
      new Request(url, {
        method,
        headers: {
          "X-MBX-APIKEY": "test-key",
          Cookie: "private",
          Authorization: "private",
        },
      }),
      fetcher,
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    const [sentUrl, init] = fetcher.mock.calls[0];
    expect(sentUrl).toBe(url);
    expect(init?.method).toBe(method);
    expect(init?.redirect).toBe("manual");
    expect([...new Headers(init?.headers)]).toEqual([
      ["x-mbx-apikey", "test-key"],
    ]);
    expect(init?.body).toBeUndefined();
  });

  it.each([
    ["POST", "https://api-gcp.binance.com/api/v3/order"],
    ["POST", "https://api-gcp.binance.com/sapi/v1/capital/withdraw/apply"],
    ["GET", "https://example.com/api/v3/account"],
    ["GET", "http://api-gcp.binance.com/api/v3/account"],
    ["DELETE", "https://api-gcp.binance.com/api/v3/account"],
    ["GET", "https://api-gcp.binance.com/sapi/v1/asset/get-funding-asset"],
  ])("rejects %s %s without fetching", async (method, url) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      (await forwardBinanceRequest(new Request(url, { method }), fetcher))
        .status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects redirects and suppresses upstream headers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "https://example.com" },
      }),
    );
    const response = await forwardBinanceRequest(
      new Request("https://api-gcp.binance.com/api/v3/account"),
      fetcher,
    );
    expect(response.status).toBe(502);
    expect(response.headers.has("Location")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not reveal request details in network errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("signature=secret"));
    const response = await forwardBinanceRequest(
      new Request("https://api-gcp.binance.com/api/v3/account"),
      fetcher,
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Binance connection failed");
  });

  it("routes Binance through the binding and prices through public fetch", async () => {
    const regional = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ regional: true }));
    const publicFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ public: true }));
    vi.stubGlobal("fetch", publicFetch);
    const fetcher = exchangeFetch({
      BINANCE_HTTP: { fetch: regional },
    });
    await fetcher("https://api-gcp.binance.com/api/v3/account", {
      method: "GET",
    });
    await fetcher("https://api.coinbase.com/v2/prices/USDT-USD/spot");
    expect(regional).toHaveBeenCalledTimes(1);
    expect(publicFetch).toHaveBeenCalledTimes(1);
    expect(publicFetch.mock.calls[0][0]).toContain("api.coinbase.com");
  });

  it("fails closed without the regional binding", () => {
    const publicFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", publicFetch);
    expect(() =>
      exchangeFetch({})("https://api-gcp.binance.com/api/v3/account"),
    ).toThrow("Binance 區域連線服務尚未設定");
    expect(publicFetch).not.toHaveBeenCalled();
  });
});
