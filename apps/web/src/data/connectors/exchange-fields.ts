const credentials = [
  {
    key: "apiKey",
    label: "唯讀 API Key（請關閉交易、轉帳與提領權限）",
    type: "password",
  },
  { key: "apiSecret", label: "API Secret", type: "password" },
] as const;
export const exchangeFields = {
  binance: [...credentials],
  bybit: [...credentials],
  okx: [
    ...credentials,
    { key: "passphrase", label: "API Passphrase", type: "password" },
  ],
} as const;
