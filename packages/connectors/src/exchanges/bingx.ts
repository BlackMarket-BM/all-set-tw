import { z } from "zod";
import {
  decimal,
  symbol,
  ExchangeError,
  jsonRequest,
  parsePayload,
  type privateClient,
} from "./http";

const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ code: z.literal(0), data });
const permissions = z.object({ permissions: z.array(z.number().int()).min(1) });
const balances = envelope(
  z.object({
    balances: z.array(
      z.object({
        asset: symbol,
        free: decimal.refine((v) => v >= 0),
        locked: decimal.refine((v) => v >= 0),
      }),
    ),
  }),
);

export async function bingx(request: ReturnType<typeof privateClient>) {
  // Official docs show an unwrapped permissions object; accept the standard
  // success envelope too, but never accept an error envelope as permissions.
  const raw = await request("/openApi/v1/account/apiPermissions");
  const key = parsePayload(
    z.union([
      envelope(permissions).transform((value) => value.data),
      permissions.extend({ code: z.undefined() }),
    ]),
    raw,
  );
  if (key.permissions.some((permission) => permission !== 2))
    throw new ExchangeError(
      "BingX 請使用只有讀取（2）權限的 API Key，關閉交易、轉帳與提領權限。",
    );
  const spot = parsePayload(
    balances,
    await request("/openApi/spot/v1/account/balance"),
  );
  const fund = parsePayload(
    balances,
    await request("/openApi/fund/v1/account/balance"),
  );
  return {
    usdEquity: 0,
    holdings: [
      ...spot.data.balances.map((row) => ({
        asset: row.asset,
        quantity: row.free + row.locked,
        wallet: "現貨",
      })),
      ...fund.data.balances.map((row) => ({
        asset: row.asset,
        quantity: row.free + row.locked,
        wallet: "資金",
      })),
    ].filter((row) => row.asset !== "VST"), // Demo currency has no real asset value.
  };
}

export async function bingxPrices(fetcher: typeof fetch) {
  const result = parsePayload(
    envelope(
      z.array(
        z.object({
          symbol: z.string().regex(/^[A-Z0-9_]+-[A-Z0-9_]+$/),
          price: decimal,
        }),
      ),
    ),
    await jsonRequest(
      fetcher,
      "https://open-api.bingx.com/openApi/spot/v2/quote/price",
    ),
  );
  return new Map(
    result.data.map((row) => [row.symbol.replace("-", ""), row.price]),
  );
}
