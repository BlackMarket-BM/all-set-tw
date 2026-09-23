export const exchangeConnectorIds = ["binance", "bybit", "okx"] as const;
const common = {
  connectionMode: "api_credentials",
  scopes: ["all"],
  capabilities: ["bank_account", "bank_balance_snapshot"],
  publicFields: [],
  credentialFields: ["apiKey", "apiSecret"],
  secretStateFields: [],
  resetOnCredentialChangeFields: [],
} as const;
export const exchangeConnectorCatalog = {
  binance: {
    ...common,
    id: "binance",
    title: "Binance",
    description: "唯讀現貨／資金資產台幣估值；不含合約、槓桿與 Earn",
  },
  bybit: {
    ...common,
    id: "bybit",
    title: "Bybit",
    description: "唯讀統一帳戶淨值與資金資產台幣估值；不含 Earn",
  },
  okx: {
    ...common,
    id: "okx",
    title: "OKX",
    description: "唯讀現貨／資金資產台幣估值；不含合約、槓桿與 Earn",
    credentialFields: ["apiKey", "apiSecret", "passphrase"],
  },
} as const;
