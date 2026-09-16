# 同步活動明細交接

更新日期：2026-09-16。接手分支：`feat/sync-activity-details`。

## 目前狀態與任務

- 使用者希望在總覽的同步報告中，看出每個銀行／資料來源這次究竟同步了哪些活動，而不只有新增筆數。
- 功能已實作，尚待完成驗證與 review；請直接接續此分支，不要重新實作。
- 原實作 commit 為 `01d7751`；已 rebase 到當次取得的最新 `origin/main`（`13a08f0`，第一銀行多裝置登入與信用卡同步修正），rebase 後實作 commit 為 `88a7af6`，沒有衝突。
- 本次交接不包含部署、套用正式 D1 migration 或合併至 main。
- 修改前先讀根目錄 `AGENTS.md` 及 `docs/002-backend-architecture.md`、`docs/003-frontend-architecture.md`；涉及 connector 時另讀 `docs/004-connector-development.md`。

## 已實作的行為

1. 總覽卡片改名為「最近一次排程同步」。每個來源可展開「查看本次活動」，展開才請求明細。
2. 顯示活動名稱、日期、原幣金額、同步時間，以及「新增活動」「已入帳」「補上發票」標記；遵循既有隱藏金額設定。
3. 同步時記錄變動快照，不用交易日期或目前資料反推歷史同步內容；補抓舊交易也會列入。
4. 重用活動頁配對邏輯，合併待入帳／已入帳與交易／發票，避免在同一來源中重複計算同一筆消費。同一活動可出現在不同來源的明細中。
5. 保持既有新增資料筆數語意；配對後活動數可能與原始新增筆數不同，畫面有說明。
6. 手動完整同步補救失敗來源時，綁定原報告與 run；單獨的任意手動同步報告、自訂排程報告、任意欄位修改歷史不在這次範圍。
7. 每頁 30 筆；前端用來源 `recoveredAt ?? completedAt` 作為 revision／`asOf`，避免分頁途中混入稍後的補救 run。
8. 舊報告顯示無保存明細；投影未完成顯示整理中，可重新整理；支援空清單、失敗重試、載入更多與手機排版。

## 主要檔案與資料流

| 檔案                                                                                                                   | 職責                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/db/migrations/0047_sync_activity_details.sql`                                                                | 新增 runs、changes、details 三張表，FK 隨報告／run 刪除                                                  |
| `packages/db/src/schema/sync.ts`                                                                                       | 對應 Drizzle schema                                                                                      |
| `apps/worker/src/features/sync/activity-capture.ts`                                                                    | 在 staging promotion 的同一個 D1 batch 前後記錄新增、入帳及發票／交易快照                                |
| `apps/worker/src/features/sync/activity-detail-repository.ts`                                                          | run 註冊、CAS 後發布、原子寫入投影、分頁與未完成投影查詢                                                 |
| `apps/worker/src/features/sync/activity-detail-service.ts`                                                             | 配對與去重、快照投影、安全重試                                                                           |
| `apps/worker/src/features/sync/persistence.ts`                                                                         | 將 capture 接入既有金融資料提交交易                                                                      |
| `apps/worker/src/features/sync/einvoice-run-repository.ts`                                                             | durable 電子發票直接 promotion 的 capture 與重播保護                                                     |
| `apps/worker/src/features/sync/scheduler.ts`、`notification-batch-repository.ts`                                       | 排程 run 關聯、報告發布、未完成投影補做                                                                  |
| `apps/worker/src/features/sync/report-repository.ts`、`service.ts`、`tdcc-sync-service.ts`、`einvoice-sync-service.ts` | 手動補救與 durable run 綁定、結果發布                                                                    |
| `apps/worker/src/features/sync/schedule-route.ts`                                                                      | `GET /sync-reports/:batchId/sources/:connectorId/activities?offset=0&asOf=ISO`；不存在回 404，GET 不寫入 |
| `packages/core/src/index.ts`                                                                                           | `SyncActivityDetail`、`SyncActivityDetailsPage` 共用契約                                                 |
| `apps/web/src/data/sync-reports/queries.ts`                                                                            | infinite query、revision 與 lazy enabled                                                                 |
| `apps/web/src/features/overview/components/SyncActivityDetails.svelte`                                                 | 展開明細、狀態、分頁與金額顯示                                                                           |
| `apps/web/src/features/overview/components/LatestSyncReportCard.svelte`、`OverviewPage.svelte`                         | 卡片整合與 API 傳遞                                                                                      |

### 維護時必須保留的條件

- `publishActivityRunStatement` 使用 SQLite `changes() = 1`，必須緊接來源結果／補救 CAS，並在同一 D1 batch 裡執行。
- 金融資料寫入與變動 capture 必須原子提交；不能讓紀錄新增明細的錯誤留下半套金融資料。
- 投影失敗不能把已成功提交的金融同步改標為失敗；保留未完成狀態，交由 scheduler 補做。
- `saveActivityDetails` 以同一 D1 batch 插入所有分塊並設定 materialized，避免部分投影被當成完成。
- pending 暫存 marker 在 promotion 後清除或改為 posted；journal 不保存 connector 原始敏感 payload。
- durable 手動補救使用啟動時綁定的 batch，不能在完成時重新找「最新報告」。
- Svelte Query 使用已安裝版本支援的 `createInfiniteQuery(toStore(() => options))`。
- DB 文件為產生檔：改 schema 時更新 metadata，執行根目錄 `npm run db:schema:docs`，不要直接手改。

## 驗證紀錄

### Rebase 前已執行

- 根目錄 format check、typecheck、build 通過。
- Worker：64 個測試檔、568 tests 通過；DB：6 個測試檔、19 tests 通過；Web unit：25 個測試檔、120 tests 通過。
- `test:backend` 的 Worker／DB 通過，但 tsx CLI 在當時環境建立 `/tmp/tsx-0/*.pipe` 時遇到 EPERM；改用 `node --import tsx tests/selfcheck/<name>.selfcheck.ts` 執行同一組九個 connector selfchecks，全部通過；deploy tests 也通過。沒有修改 package scripts 規避問題。
- 新增 E2E `apps/web/e2e/sync-activity-details.spec.ts` 的 desktop／mobile 共 2 tests 通過。
- 全部 E2E：42 通過、4 失敗，尚未確認失敗是否存在於 main，不可宣稱都是既有問題。

四個待釐清的 E2E：

| 檔案                      | 測試名稱／當時觀察                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `lazy-navigation.spec.ts` | `shows a retry action when a lazy page fails to load`                                                                     |
| `shell.spec.ts`           | `shows this month's cash flow on the overview and opens activity`；fixture 無 configured jobs，與 insights 預期可能不一致 |
| `shell.spec.ts`           | `shows reliable activity times and sorts them on desktop and mobile`                                                      |
| `shell.spec.ts`           | `excludes a bank transaction from activity calculations and restores it`；reload 後 modal 攔截操作                        |

先前瀏覽器環境說明：標準 Playwright Chromium 下載逾時，曾使用臨時 `@sparticuz/chromium` executable、no-sandbox／disable-dev-shm-usage／disable-gpu 參數及 Noto Sans TC 字型跑測試。這些臨時環境與 logs 不隨 repo 保存；不要依賴 `/tmp` 路徑。在正常 Codex 環境優先使用專案標準 Playwright 設定。

### Rebase 後本次驗證

- 根目錄 `npm run format:check`、`npm run typecheck` 通過。
- Worker：64 個測試檔、577 tests 通過；DB：6 個測試檔、19 tests 通過。
- `npm run test:backend` 再次在 tsx CLI 的 IPC socket 遇到 EPERM；Worker／DB 已通過，九個 connector selfchecks 改用下列等價入口後全部通過。`npm run test:deploy`：16 tests 通過。
- Web unit：25 個測試檔、121 tests 通過；根目錄 `npm run build` 通過。
- 本次沒有重跑完整 E2E；上述四項失敗仍需要接手者釐清。

tsx 環境問題的替代執行方式（從 `packages/connectors` 執行，不修改既有 scripts）：

```bash
for name in tdcc einvoice einvoice-v2 taishin ctbc skbank obank firstbank hncb; do
  node --import tsx "tests/selfcheck/$name.selfcheck.ts" || exit
done
```

## Codex 接手順序

1. Fetch 並 checkout `feat/sync-activity-details`，確認實作與此交接文件都存在。
2. 優先在標準瀏覽器環境重跑上述四項 E2E；使用乾淨 main checkout 跑相同測試，判定是否為本分支 regression，再修正相關問題。不要僅憑先前推測修改無關行為。
3. Review 原子 capture／CAS 發布／durable 重播／手動補救 batch 綁定／`asOf` 分頁，以及跨來源發票配對。新增 integration tests 已涵蓋主要情境，先讀再補必要缺口。
4. 測試入口：Worker `apps/worker/tests/features/sync/activity-details.test.ts`（8 個 D1 integration cases）、Web colocated `SyncActivityDetails.test.ts`（3 cases）、E2E `sync-activity-details.spec.ts`（2 cases）。
5. 依 `AGENTS.md` 從 repo root 執行 format check → typecheck → backend tests → unit tests → build；完成 E2E 與必要修正後再回報可否開 PR。
6. 部署前需要 migration 0047；若 main 後續新增同編號 migration，先處理編號及對應 schema 文件，不要直接部署衝突 migration。

可直接交給下一個 Codex 的任務：

> 請接續 `feat/sync-activity-details`，先讀 `AGENTS.md` 與 `docs/sync-activity-details-handoff.md`。總覽同步活動明細已完成主要實作，請優先釐清交接列出的四項 E2E 失敗並與 main 比對，review 同步 journal 與補救／分頁的一致性，完成必要修正和專案要求的驗證，再回報結果。請保留現有功能範圍與提交，不要重新實作，也不要部署正式環境。
