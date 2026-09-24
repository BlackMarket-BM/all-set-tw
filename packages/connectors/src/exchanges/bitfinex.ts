import { z } from "zod";
import {
  ExchangeError,
  jsonRequest,
  parsePayload,
  symbol,
  type privateClient,
} from "./http";

// Bitfinex uses UST for Tether; keep other currency codes native to avoid ambiguous aliases.
const currency = (value: string) => (value === "UST" ? "USDT" : value);

export async function bitfinex(request: ReturnType<typeof privateClient>) {
  const permissions = parsePayload(
    z
      .array(
        z.tuple([
          z.string(),
          z.union([z.literal(0), z.literal(1)]),
          z.union([z.literal(0), z.literal(1)]),
        ]),
      )
      .min(1),
    await request("/v2/auth/r/permissions"),
  );
  if (
    permissions.some((row) => row[2] !== 0) ||
    !permissions.some((row) => row[0] === "wallets" && row[1] === 1)
  )
    throw new ExchangeError(
      "請使用只有讀取權限的 API Key，啟用 Wallets 讀取並關閉所有寫入權限。",
    );
  const wallets = parsePayload(
    z.array(
      z
        .tuple([
          z.string(),
          symbol,
          z.number().finite(),
          z.number().finite(),
          z.number().finite().nullable(),
        ])
        .rest(z.unknown()),
    ),
    await request("/v2/auth/r/wallets"),
  );
  return {
    usdEquity: 0,
    // BALANCE already includes reserved funds. Never add available balance or funding credits.
    // Unsettled interest is separate and not yet credited to the wallet.
    holdings: wallets
      .filter((row) => row[0] === "exchange" || row[0] === "funding")
      .map((row) => ({
        asset: currency(row[1]),
        quantity: row[2],
        wallet: row[0] === "exchange" ? "現貨" : "資金",
      })),
  };
}

export async function bitfinexPrices(fetcher: typeof fetch) {
  const rows = parsePayload(
    z.array(z.array(z.unknown())),
    await jsonRequest(
      fetcher,
      "https://api-pub.bitfinex.com/v2/tickers?symbols=ALL",
    ),
  );
  const result = new Map<string, number>();
  for (const row of rows) {
    if (typeof row[0] !== "string" || !row[0].startsWith("t")) continue;
    const ticker = parsePayload(
      z
        .tuple([
          z.string(),
          z.unknown(),
          z.unknown(),
          z.unknown(),
          z.unknown(),
          z.unknown(),
          z.unknown(),
          z.number().finite(),
        ])
        .rest(z.unknown()),
      row,
    );
    const pair = ticker[0].slice(1);
    const [base, quote] = pair.includes(":")
      ? pair.split(":")
      : [pair.slice(0, -3), pair.slice(-3)];
    if (base && (quote === "USD" || quote === "UST"))
      result.set(currency(base) + currency(quote), ticker[7]);
  }
  return result;
}
