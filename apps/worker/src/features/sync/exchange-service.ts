import { syncExchange, type ExchangeId } from "@taiwan-fin-hub/connectors";
import { getConnectorSettings } from "@taiwan-fin-hub/db";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson } from "../../platform/crypto";
import type { Env } from "../../platform/env";
import { dateFromIso, rebuildBankDepositHistory } from "../net-worth/service";
import { persistStagedSyncWrite } from "./persistence";
import { bankAccountRecord, bankBalanceSnapshotRecord } from "./record-mapper";
import { connectorCursorStatement } from "./repository";
import { exchangeSettingsGuard } from "./exchange-repository";
import type { SyncOutcome } from "./service";

export async function syncExchangeAssets(
  env: Env,
  connectorId: ExchangeId,
): Promise<SyncOutcome> {
  const settings = await getConnectorSettings(env.DB, connectorId);
  if (!settings) throw new Error("請先設定交易所 API Key。");
  const config = await decryptJson(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const result = await syncExchange(connectorId, config);
  const now = result.cursor!;
  const records = [
    ...(result.bankAccounts ?? []).map((row) =>
      bankAccountRecord(connectorId, row, now),
    ),
    ...(result.bankBalanceSnapshots ?? []).map((row) =>
      bankBalanceSnapshotRecord(connectorId, row, now),
    ),
  ];
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    beforePromoteStatements: [
      exchangeSettingsGuard(env.DB, connectorId, settings.updated_at),
    ],
    finalizeStatements: [
      connectorCursorStatement(env.DB, connectorId, now, now),
    ],
  });
  await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
  return {
    success: true,
    connectorId,
    scope: "all",
    records: records.length,
    newRecords,
    cursorUpdated: now !== settings.sync_cursor,
  };
}
