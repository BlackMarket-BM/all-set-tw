import { z } from "zod";
import {
  decimal,
  symbol,
  parsePayload,
  ExchangeError,
  type privateClient,
} from "./http";
type Holding = { asset: string; quantity: number; wallet: string };
const futuresWalletNames = ["USDⓈ-M Futures", "COIN-M Futures"] as const;
const walletSchema = z.array(
  z.object({ walletName: z.string(), activate: z.boolean(), balance: decimal }),
);
function parseFutures(raw: unknown) {
  const result = walletSchema.safeParse(raw);
  if (!result.success)
    throw new ExchangeError("Binance 合約錢包總覽回應不完整；未更新資產。");
  const wallets = result.data.filter((row) =>
    futuresWalletNames.some((name) => name === row.walletName),
  );
  if (
    wallets.length !== 2 ||
    new Set(wallets.map((row) => row.walletName)).size !== 2 ||
    wallets.some((row) => !row.activate && row.balance !== 0)
  )
    throw new ExchangeError(
      "Binance 合約錢包總覽缺少帳戶或資料不一致；未更新資產。",
    );
  return wallets;
}

export async function binance(
  request: ReturnType<typeof privateClient>,
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
    throw new ExchangeError(
      "請使用只有讀取權限的 API Key，關閉交易、轉帳與提領權限。",
    );
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
  const futures = parseFutures(
    await request("/sapi/v1/asset/wallet/balance", { quoteAsset: "USDT" }),
  );
  return {
    usdEquity: 0,
    holdings: [
      ...futures.map((row) => ({
        asset: "USDT",
        quantity: row.balance,
        wallet: row.walletName + "（總覽折合估值）",
      })),
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
