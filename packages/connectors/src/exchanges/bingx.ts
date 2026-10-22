import { z } from "zod";
import {
  decimal,
  symbol,
  ExchangeError,
  jsonRequest,
  type privateClient,
} from "./http";

const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ code: z.literal(0), data });
const permission = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/).transform(Number).refine(Number.isSafeInteger),
]);
const permissions = z.object({ permissions: z.array(permission).min(1) });

function parseBingx<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  raw: unknown,
  stage: string,
): T {
  if (raw && typeof raw === "object" && "code" in raw) {
    const code = (raw as { code: unknown }).code;
    if (typeof code === "number" && Number.isSafeInteger(code) && code !== 0)
      throw new ExchangeError(
        `BingX ${stage}失敗（代碼 ${code}）；未更新資產。`,
      );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ExchangeError(`BingX ${stage}回應格式不符；未更新資產。`);
  return parsed.data;
}
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

// Observed fund response: data.assets with numeric amounts (spot uses strings).
const fundAmount = z
  .union([decimal, z.number().finite()])
  .refine((v) => v >= 0);
const fundBalances = z.union([
  balances.transform((value) => value.data.balances),
  envelope(
    z.object({
      assets: z.array(
        z.object({ asset: symbol, free: fundAmount, locked: fundAmount }),
      ),
    }),
  ).transform((value) => value.data.assets),
]);

export async function bingx(request: ReturnType<typeof privateClient>) {
  // Official docs show an unwrapped permissions object; accept the standard
  // success envelope too, but never accept an error envelope as permissions.
  const raw = await request("/openApi/v1/account/apiPermissions");
  const key = parseBingx(
    z.union([
      envelope(permissions).transform((value) => value.data),
      permissions.extend({ code: z.undefined() }),
    ]),
    raw,
    "API Key 權限檢查",
  );
  if (key.permissions.some((permission) => permission !== 2))
    throw new ExchangeError(
      "BingX 請使用只有讀取（2）權限的 API Key，關閉交易、轉帳與提領權限。",
    );
  const spot = parseBingx(
    balances,
    await request("/openApi/spot/v1/account/balance"),
    "現貨帳戶查詢",
  );
  const fund = parseBingx(
    fundBalances,
    await request("/openApi/fund/v1/account/balance"),
    "資金帳戶查詢",
  );
  return {
    usdEquity: 0,
    holdings: [
      ...spot.data.balances.map((row) => ({
        asset: row.asset,
        quantity: row.free + row.locked,
        wallet: "現貨",
      })),
      ...fund.map((row) => ({
        asset: row.asset,
        quantity: row.free + row.locked,
        wallet: "資金",
      })),
    ].filter((row) => row.asset !== "VST"), // Demo currency has no real asset value.
  };
}

export async function bingxPrices(fetcher: typeof fetch) {
  const result = parseBingx(
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
    "現貨價格查詢",
  );
  return new Map(
    result.data.map((row) => [row.symbol.replace("-", ""), row.price]),
  );
}
