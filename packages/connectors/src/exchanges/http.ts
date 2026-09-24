import { z } from "zod";

export const exchangeIds = ["binance", "bybit", "okx", "bitfinex"] as const;
export type ExchangeId = (typeof exchangeIds)[number];
export const exchangeConfigSchema = z.object({
  apiKey: z.string().trim().min(1).max(512),
  apiSecret: z.string().trim().min(1).max(512),
});
export const okxConfigSchema = exchangeConfigSchema.extend({
  passphrase: z.string().min(1).max(512),
});
export type ExchangeConfig = z.infer<typeof exchangeConfigSchema> & {
  passphrase?: string;
};

export class ExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExchangeError";
  }
}

export async function hmac(
  secret: string,
  message: string,
  encoding: "hex" | "base64" = "hex",
  hash: "SHA-256" | "SHA-384" = "SHA-256",
) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(message)),
  );
  return encoding === "hex"
    ? Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    : btoa(String.fromCharCode(...bytes));
}

// Every private endpoint is explicitly allowlisted. No orders, transfers or withdrawals.
const origins = {
  binance: "https://api.binance.com",
  bybit: "https://api.bybit.com",
  okx: "https://www.okx.com",
  bitfinex: "https://api.bitfinex.com",
};
const paths: Record<ExchangeId, readonly string[]> = {
  bitfinex: ["/v2/auth/r/permissions", "/v2/auth/r/wallets"],
  binance: [
    "/sapi/v1/account/apiRestrictions",
    "/api/v3/account",
    "/sapi/v1/asset/get-funding-asset",
  ],
  bybit: [
    "/v5/user/query-api",
    "/v5/account/wallet-balance",
    "/v5/asset/transfer/query-account-coins-balance",
  ],
  okx: [
    "/api/v5/account/config",
    "/api/v5/account/balance",
    "/api/v5/asset/balances",
  ],
};

export async function jsonRequest(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  try {
    const response = await fetcher(url, {
      ...init,
      // Workers only supports follow/manual; reject 3xx below without forwarding credentials.
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new ExchangeError(
        `交易所／價格服務 HTTP ${response.status}；未更新資產。`,
      );
    // Read a bounded response and never expose upstream payloads or signed URLs in errors.
    const reader = response.body?.getReader();
    if (!reader) throw new ExchangeError("來源回傳空白資料。");
    const decoder = new TextDecoder();
    let length = 0;
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4_000_000) {
        await reader.cancel();
        throw new ExchangeError("來源資料超過大小限制。");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof ExchangeError) throw error;
    throw new ExchangeError(
      "交易所／價格服務無法連線或資料格式錯誤；未更新資產。",
    );
  }
}

export function parsePayload<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  payload: unknown,
): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new ExchangeError("來源資料不完整或格式已變更；未更新資產。");
  return parsed.data;
}

export function privateClient(
  id: ExchangeId,
  config: ExchangeConfig,
  fetcher: typeof fetch,
  now: () => number,
) {
  let lastNonce = 0;
  return async (path: string, params: Record<string, string> = {}) => {
    if (!paths[id].includes(path))
      throw new ExchangeError("不允許的交易所操作。");
    const query = new URLSearchParams(params);
    let method = "GET";
    let headers: Record<string, string> = {};
    let url: string;
    let body: string | undefined;
    if (id === "bitfinex") {
      lastNonce = Math.max(now() * 1000, lastNonce + 1);
      const nonce = String(lastNonce);
      body = JSON.stringify(params);
      method = "POST";
      headers = {
        "content-type": "application/json",
        "bfx-apikey": config.apiKey,
        "bfx-nonce": nonce,
        "bfx-signature": await hmac(
          config.apiSecret,
          `/api${path}${nonce}${body}`,
          "hex",
          "SHA-384",
        ),
      };
      url = origins[id] + path;
    } else if (id === "binance") {
      query.set("timestamp", String(now()));
      query.set("recvWindow", "5000");
      query.set("signature", await hmac(config.apiSecret, query.toString()));
      // Binance defines this read-only asset query as POST; it does not move funds.
      if (path === "/sapi/v1/asset/get-funding-asset") method = "POST";
      headers = { "X-MBX-APIKEY": config.apiKey };
      url = `${origins[id]}${path}?${query}`;
    } else if (id === "bybit") {
      const timestamp = String(now());
      headers = {
        "X-BAPI-API-KEY": config.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": "5000",
        "X-BAPI-SIGN": await hmac(
          config.apiSecret,
          timestamp + config.apiKey + "5000" + query.toString(),
        ),
      };
      url = `${origins[id]}${path}${query.size ? `?${query}` : ""}`;
    } else {
      const timestamp = new Date(now()).toISOString();
      const requestPath = path + (query.size ? `?${query}` : "");
      headers = {
        "OK-ACCESS-KEY": config.apiKey,
        "OK-ACCESS-PASSPHRASE": config.passphrase ?? "",
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-SIGN": await hmac(
          config.apiSecret,
          timestamp + "GET" + requestPath,
          "base64",
        ),
      };
      url = origins[id] + requestPath;
    }
    return jsonRequest(fetcher, url, { method, headers, body });
  };
}

export const decimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .transform(Number)
  .refine(Number.isFinite);
export const symbol = z.string().regex(/^[\p{L}\p{N}_]{1,64}$/u);
