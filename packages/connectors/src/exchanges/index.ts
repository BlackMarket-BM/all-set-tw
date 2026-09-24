import { z } from "zod";
import { bitfinex, bitfinexPrices } from "./bitfinex";
import type { SyncResult } from "@taiwan-fin-hub/core";
import {
  decimal,
  symbol,
  exchangeConfigSchema,
  okxConfigSchema,
  ExchangeError,
  jsonRequest,
  parsePayload,
  privateClient,
  type ExchangeId,
} from "./http";
export { exchangeConfigSchema, okxConfigSchema, ExchangeError } from "./http";
export type { ExchangeId } from "./http";
export const binanceConfigSchema = exchangeConfigSchema;
export const bybitConfigSchema = exchangeConfigSchema;
export const bitfinexConfigSchema = exchangeConfigSchema;
export const parseBitfinexConfig = (value: unknown) =>
  bitfinexConfigSchema.parse(value);
export type BitfinexConfig = z.infer<typeof bitfinexConfigSchema>;
export const parseBinanceConfig = (value: unknown) =>
  binanceConfigSchema.parse(value);
export const parseBybitConfig = (value: unknown) =>
  bybitConfigSchema.parse(value);
export const parseOkxConfig = (value: unknown) => okxConfigSchema.parse(value);
export type BinanceConfig = z.infer<typeof binanceConfigSchema>;
export type BybitConfig = z.infer<typeof bybitConfigSchema>;
export type OkxConfig = z.infer<typeof okxConfigSchema>;

type Holding = { asset: string; quantity: number; wallet: string };
type Request = ReturnType<typeof privateClient>;
const readOnlyError = () =>
  new ExchangeError("請使用只有讀取權限的 API Key，關閉交易、轉帳與提領權限。");
const bybitEnvelope = <T extends z.ZodTypeAny>(result: T) =>
  z.object({ retCode: z.literal(0), result });
const okxEnvelope = <T extends z.ZodTypeAny>(row: T) =>
  z.object({ code: z.literal("0"), data: z.array(row) });

async function binance(
  request: Request,
): Promise<{ holdings: Holding[]; usdEquity: number }> {
  const permissions = parsePayload(
    z.object({
      enableReading: z.literal(true),
      enableWithdrawals: z.boolean(),
      enableInternalTransfer: z.boolean(),
      enableMargin: z.boolean(),
      enableFutures: z.boolean(),
      permitsUniversalTransfer: z.boolean(),
      enableVanillaOptions: z.boolean(),
      enableSpotAndMarginTrading: z.boolean(),
      enableFixApiTrade: z.boolean().optional(),
      enablePortfolioMarginTrading: z.boolean().optional(),
    }),
    await request("/sapi/v1/account/apiRestrictions"),
  );
  if (
    Object.entries(permissions).some(
      ([key, value]) => key !== "enableReading" && value === true,
    )
  )
    throw readOnlyError();
  const spot = parsePayload(
    z.object({
      balances: z.array(
        z.object({ asset: symbol, free: decimal, locked: decimal }),
      ),
    }),
    await request("/api/v3/account"),
  );
  const funding = parsePayload(
    z.array(
      z.object({
        asset: symbol,
        free: decimal,
        locked: decimal,
        freeze: decimal,
        withdrawing: decimal,
      }),
    ),
    await request("/sapi/v1/asset/get-funding-asset"),
  );
  return {
    usdEquity: 0,
    holdings: [
      ...spot.balances.map((row) => ({
        asset: row.asset,
        quantity: row.free + row.locked,
        wallet: "現貨",
      })),
      ...funding.map((row) => ({
        asset: row.asset,
        quantity: row.free + row.locked + row.freeze + row.withdrawing,
        wallet: "資金",
      })),
    ],
  };
}

async function bybit(
  request: Request,
): Promise<{ holdings: Holding[]; usdEquity: number }> {
  const key = parsePayload(
    bybitEnvelope(z.object({ readOnly: z.number() })),
    await request("/v5/user/query-api"),
  );
  if (key.result.readOnly !== 1) throw readOnlyError();
  const unified = parsePayload(
    bybitEnvelope(
      z.object({
        list: z
          .array(
            z.object({
              accountType: z.literal("UNIFIED"),
              totalEquity: decimal,
            }),
          )
          .length(1),
      }),
    ),
    await request("/v5/account/wallet-balance", { accountType: "UNIFIED" }),
  );
  const funding = parsePayload(
    bybitEnvelope(
      z.object({
        accountType: z.literal("FUND"),
        balance: z.array(z.object({ coin: symbol, walletBalance: decimal })),
      }),
    ),
    await request("/v5/asset/transfer/query-account-coins-balance", {
      accountType: "FUND",
    }),
  );
  // Account equity already includes unrealised P&L and liabilities. Never add coin balances again.
  return {
    usdEquity: unified.result.list[0].totalEquity,
    holdings: funding.result.balance.map((row) => ({
      asset: row.coin,
      quantity: row.walletBalance,
      wallet: "資金",
    })),
  };
}

async function okx(
  request: Request,
): Promise<{ holdings: Holding[]; usdEquity: number }> {
  const key = parsePayload(
    okxEnvelope(z.object({ perm: z.string() })),
    await request("/api/v5/account/config"),
  );
  if (key.data.length !== 1 || key.data[0].perm !== "read_only")
    throw readOnlyError();
  const trading = parsePayload(
    okxEnvelope(
      z.object({
        details: z.array(
          z.object({
            ccy: symbol,
            cashBal: decimal,
            liab: z.union([decimal, z.literal("")]).optional(),
          }),
        ),
      }),
    ),
    await request("/api/v5/account/balance"),
  );
  if (trading.data.length !== 1)
    throw new ExchangeError("OKX 未回傳完整交易帳戶資料。");
  if (
    trading.data[0].details.some(
      (row) => typeof row.liab === "number" && row.liab !== 0,
    )
  )
    throw new ExchangeError(
      "OKX 偵測到借貸；目前僅支援無借貸的現貨資產，未更新估值。",
    );
  const funding = parsePayload(
    okxEnvelope(z.object({ ccy: symbol, bal: decimal })),
    await request("/api/v5/asset/balances"),
  );
  return {
    usdEquity: 0,
    holdings: [
      ...trading.data[0].details.map((row) => ({
        asset: row.ccy,
        quantity: row.cashBal,
        wallet: "現貨",
      })),
      ...funding.data.map((row) => ({
        asset: row.ccy,
        quantity: row.bal,
        wallet: "資金",
      })),
    ],
  };
}

async function prices(id: ExchangeId, fetcher: typeof fetch) {
  if (id === "bitfinex") return bitfinexPrices(fetcher);
  if (id === "binance") {
    const rows = parsePayload(
      z.array(z.object({ symbol, price: decimal })),
      await jsonRequest(fetcher, "https://api.binance.com/api/v3/ticker/price"),
    );
    return new Map(rows.map((row) => [row.symbol, row.price]));
  }
  if (id === "bybit") {
    const rows = parsePayload(
      bybitEnvelope(
        z.object({ list: z.array(z.object({ symbol, lastPrice: decimal })) }),
      ),
      await jsonRequest(
        fetcher,
        "https://api.bybit.com/v5/market/tickers?category=spot",
      ),
    );
    return new Map(rows.result.list.map((row) => [row.symbol, row.lastPrice]));
  }
  const rows = parsePayload(
    okxEnvelope(z.object({ instId: z.string(), last: decimal })),
    await jsonRequest(
      fetcher,
      "https://www.okx.com/api/v5/market/tickers?instType=SPOT",
    ),
  );
  return new Map(
    rows.data.map((row) => [row.instId.replaceAll("-", ""), row.last]),
  );
}

export async function syncExchange(
  id: ExchangeId,
  rawConfig: unknown,
  options: { fetcher?: typeof fetch; now?: () => number } = {},
): Promise<SyncResult<never>> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const parsed = (
    id === "okx" ? okxConfigSchema : exchangeConfigSchema
  ).safeParse(rawConfig);
  if (!parsed.success)
    throw new ExchangeError(
      "請先完整設定 API Key、Secret 與必要的 Passphrase。",
    );
  const request = privateClient(id, parsed.data, fetcher, now);
  const data = await { binance, bybit, okx, bitfinex }[id](request);
  const holdings = data.holdings.filter((row) => row.quantity !== 0);
  const ticks = holdings.length
    ? await prices(id, fetcher)
    : new Map<string, number>();
  // USDT is priced in USD; it is never assumed to be pegged 1:1.
  const usdt = holdings.some(
    (row) => row.asset !== "USD" && row.asset !== "TWD",
  )
    ? parsePayload(
        z.object({
          data: z.object({
            base: z.literal("USDT"),
            currency: z.literal("USD"),
            amount: decimal,
          }),
        }),
        await jsonRequest(
          fetcher,
          "https://api.coinbase.com/v2/prices/USDT-USD/spot",
        ),
      ).data.amount
    : 1;
  if (usdt <= 0) throw new ExchangeError("USDT/USD 價格無效。");
  const fx = parsePayload(
    z.object({
      result: z.literal("success"),
      base_code: z.literal("TWD"),
      time_last_update_unix: z.number().positive(),
      rates: z.object({ USD: z.number().positive().finite() }),
    }),
    await jsonRequest(fetcher, "https://open.er-api.com/v6/latest/TWD"),
  );
  if (
    now() - fx.time_last_update_unix * 1000 > 72 * 3600_000 ||
    fx.time_last_update_unix * 1000 > now() + 300_000
  )
    throw new ExchangeError("台幣匯率已過期或時間無效；未更新資產。");
  const usdTwd = 1 / fx.rates.USD;
  const valued = holdings.map((row) => {
    let rate: number;
    if (row.asset === "TWD") rate = 1;
    else if (row.asset === "USD") rate = usdTwd;
    else if (row.asset === "USDT") rate = usdt * usdTwd;
    else if (id === "bitfinex" && (ticks.get(row.asset + "USD") ?? 0) > 0)
      rate = ticks.get(row.asset + "USD")! * usdTwd;
    else {
      const direct = ticks.get(row.asset + "USDT");
      const inverse = ticks.get("USDT" + row.asset);
      const quote =
        direct ?? (inverse && inverse > 0 ? 1 / inverse : undefined);
      if (!quote || quote <= 0)
        throw new ExchangeError(
          `無法取得 ${row.asset} 的 USDT 價格；未更新資產。`,
        );
      rate = quote * usdt * usdTwd;
    }
    return { ...row, twdValue: row.quantity * rate };
  });
  const balance =
    data.usdEquity * usdTwd +
    valued.reduce((sum, row) => sum + row.twdValue, 0);
  if (!Number.isFinite(balance))
    throw new ExchangeError("交易所資產估值超出範圍。");
  const asOfAt = new Date(now()).toISOString();
  const accountId = "crypto:portfolio";
  const title = {
    binance: "Binance",
    bybit: "Bybit",
    okx: "OKX",
    bitfinex: "Bitfinex",
  }[id];
  return {
    records: [],
    cursor: asOfAt,
    bankAccounts: [
      {
        sourceId: accountId,
        institutionName: title,
        accountName: `${title} 虛擬貨幣（台幣估值）`,
        accountType: "stored_value",
        currency: "TWD",
      },
    ],
    bankBalanceSnapshots: [
      {
        accountId,
        sourceId: asOfAt,
        balance,
        currency: "TWD",
        asOfAt,
        raw: {
          holdings: valued,
          unifiedEquityUsd: data.usdEquity,
          usdTwd,
          usdtUsd: usdt,
          fxUpdatedAt: new Date(fx.time_last_update_unix * 1000).toISOString(),
          coverage:
            id === "bitfinex"
              ? "現貨與資金錢包 BALANCE；不含保證金、衍生品與未結算利息"
              : id === "bybit"
                ? "統一帳戶淨值與資金帳戶；不含 Earn"
                : "現貨與資金帳戶；不含合約、槓桿與 Earn",
        },
      },
    ],
  };
}
