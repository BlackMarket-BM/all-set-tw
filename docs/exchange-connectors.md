# 交易所唯讀資產擴充

本 Fork 保留原有 `Sync Latest Version` workflow、`scripts/sync-upstream.mjs` 與 Cloudflare 部署流程。

## 範圍與估值

| 來源    | 納入範圍                                                    | 不納入／不支援                                   |
| ------- | ----------------------------------------------------------- | ------------------------------------------------ |
| Binance | 現貨可用與鎖定餘額、資金帳戶可用／鎖定／凍結／提領中餘額    | 合約、槓桿、Earn、子帳戶                         |
| Bybit   | UNIFIED `totalEquity`（USD 淨值，含損益及負債）與 FUND 餘額 | Classic／獨立保證金無總淨值的模式、Earn、子帳戶  |
| OKX     | 交易帳戶 `cashBal` 與資金帳戶 `bal`                         | 合約損益、Earn、子帳戶；偵測到借貸時整次同步失敗 |

每家交易所用一個 `stored_value` 帳戶保存 TWD 總估值，名稱明確標示「虛擬貨幣（台幣估值）」。資產頁目前在既有帳戶區塊顯示並納入總資產／淨資產與歷史，不另增資產分類。幣別數量、估值來源與匯率時間保存在白名單快照明細；介面目前顯示交易所合計。

一般幣種以該交易所現貨 USDT 交易對估值；支援反向交易對。USDT/USD 使用 Coinbase 現貨價格，再使用原專案同一匯率供應商 `open.er-api.com` 的 USD/TWD 換算，USDT 不假定等於 USD。Bybit 統一帳戶直接使用官方 USD 淨值，不能再加總其 coin 餘額。台幣匯率超過 72 小時、缺價、來源格式不完整、API 限流／權限／地區限制均讓同步失敗，保留上次成功快照及時間，不寫零或部分總額。

全部資產售出時仍寫入零快照；重複同步沿用同一帳戶 ID，不累加舊持倉。估值是同步時點值，需重新同步才會更新。

## 設定與安全

1. 在交易所建立 **HMAC 唯讀 API Key**，停用交易、轉帳、提領。OKX 另需 Passphrase。RSA／Ed25519 Key 不支援。
2. 登入受 Cloudflare Access 保護的站台，於「設定 → 資料來源」輸入憑證，再執行同步。
3. 確認資產與官方帳戶範圍一致後，可啟用排程；三個新增排程預設停用。

同步會先查 API Key 權限。所有私有端點限定在程式白名單，不提供自訂 API URL，禁止重導向，15 秒逾時，回應最大 4 MB。Binance 資金查詢依官方規格使用 POST，但這個端點只讀取資產，不移動資金。API 回應錯誤與連線例外不回傳原始 payload、簽章 URL 或憑證。

API Key、Secret、Passphrase 沿用原專案 AES-GCM 加密，僅存於 D1 `connector_settings.encrypted_config`；主金鑰使用 Worker Secret `CONFIG_ENCRYPTION_KEY`。設定 API 只回傳 metadata。同步透過原有鎖與 staged persistence，提交時檢查設定版本；同步期間更改／刪除憑證會取消整組寫入。沒有修改原專案的加密演算法、Access 驗證或總資產計算。

不要將交易所憑證、Worker 加密主金鑰、GitHub 或 Cloudflare Token 放進 Git。Cloudflare Workers 出口 IP 與交易所地區／IP 白名單限制可能影響連線；正式憑證驗收需要在實際部署執行。

## 維護與更新

實作集中在 `packages/connectors/src/exchanges/`、`packages/core/src/exchange-catalog.ts`、Worker `exchange-service.ts`／`exchange-repository.ts` 與前端 `exchange-fields.ts`。既有檔案只加入 catalog、schema、runtime、表單與通知名稱註冊。migration 只新增預設停用的 sync jobs，不改既有表結構。

上游仍會每天自動三方合併。這不是零衝突保證：註冊點與 migration 編號仍可能和未來 upstream 變更衝突，更新器會安全停止，必須檢查 GitHub Actions 並手動處理。Workers Builds 應連到此 Fork 的 `main`，使用原專案 build/deploy 指令；只有同步 workflow 而未設定 Builds，不會自動部署。

## 官方 API 依據

- [Binance Account API 與 Key 權限](https://developers.binance.com/docs/wallet/account/api-key-permission)
- [Binance Funding Wallet](https://developers.binance.com/docs/wallet/asset/funding-wallet)
- [Bybit 統一帳戶淨值](https://bybit-exchange.github.io/docs/v5/account/wallet-balance)
- [Bybit 資金帳戶](https://bybit-exchange.github.io/docs/v5/asset/balance/all-balance)
- [Bybit Key 權限](https://bybit-exchange.github.io/docs/v5/user/apikey-info)
- [OKX API](https://www.okx.com/docs-v5/en/)
- [Coinbase 價格 API](https://docs.cdp.coinbase.com/coinbase-business/track-apis/prices)
