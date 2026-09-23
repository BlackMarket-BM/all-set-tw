import { afterEach, describe, expect, it } from "vitest";
import { SqliteD1 } from "./exchange-test-db";
import { exchangeSettingsGuard } from "../../../src/features/sync/exchange-repository";
import { persistStagedSyncWrite } from "../../../src/features/sync/persistence";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
} from "../../../src/features/sync/record-mapper";
import { connectorCursorStatement } from "../../../src/features/sync/repository";
import { calculateBankDepositValue } from "../../../src/features/net-worth/repository";
import {
  getConnectorSettingsView,
  updateConnectorSettings,
} from "../../../src/features/connectors/service";
import { decryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";

const databases: SqliteD1[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function setup() {
  const sqlite = new SqliteD1();
  databases.push(sqlite);
  const db = sqlite as unknown as D1Database;
  return {
    sqlite,
    db,
    env: { DB: db, CONFIG_ENCRYPTION_KEY: "integration-key" } as Env,
  };
}
function records(value: number, now: string) {
  return [
    bankAccountRecord(
      "binance",
      {
        sourceId: "crypto:portfolio",
        accountName: "Binance 虛擬貨幣",
        accountType: "stored_value",
        currency: "TWD",
      },
      now,
    ),
    bankBalanceSnapshotRecord(
      "binance",
      {
        accountId: "crypto:portfolio",
        sourceId: now,
        asOfAt: now,
        balance: value,
        currency: "TWD",
      },
      now,
    ),
  ];
}
describe("交易所 D1 整合", () => {
  it("stores encrypted credentials in D1 and never returns them in settings metadata", async () => {
    const { sqlite, env } = setup();
    const credentials = {
      apiKey: "integration-api-key",
      apiSecret: "integration-secret",
      passphrase: "integration-passphrase",
    };
    await updateConnectorSettings(env, "okx", credentials);
    const row = sqlite.database
      .prepare("SELECT * FROM connector_settings WHERE connector_id='okx'")
      .get()!;
    expect(JSON.stringify(row)).not.toMatch(
      /integration-api-key|integration-secret|integration-passphrase/,
    );
    expect(
      await decryptJson(String(row.encrypted_config), "integration-key"),
    ).toEqual(credentials);
    const view = await getConnectorSettingsView(env, "okx");
    expect(view.credentialsComplete).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(
      /integration-api-key|integration-secret|integration-passphrase/,
    );
  });
  it("includes crypto TWD value once, updates it and clears sold-out balances", async () => {
    const { db } = setup();
    const first = records(1234.56, "2026-09-23T00:00:00Z");
    await persistStagedSyncWrite(db, { records: first });
    await persistStagedSyncWrite(db, { records: first });
    expect(await calculateBankDepositValue(db, "2026-09-23")).toBe(1235);
    await persistStagedSyncWrite(db, {
      records: records(0, "2026-09-23T01:00:00Z"),
    });
    expect(await calculateBankDepositValue(db, "2026-09-23")).toBe(0);
  });
  it("rolls back promotion and cursor when settings changed during sync", async () => {
    const { db, env, sqlite } = setup();
    await updateConnectorSettings(env, "binance", {
      apiKey: "key",
      apiSecret: "secret",
    });
    await persistStagedSyncWrite(db, {
      records: records(100, "2026-09-23T00:00:00Z"),
    });
    await expect(
      persistStagedSyncWrite(db, {
        records: records(999, "2026-09-23T01:00:00Z"),
        beforePromoteStatements: [
          exchangeSettingsGuard(db, "binance", "stale-version"),
        ],
        finalizeStatements: [
          connectorCursorStatement(db, "binance", "new-cursor", "new-version"),
        ],
      }),
    ).rejects.toThrow();
    expect(await calculateBankDepositValue(db, "2026-09-23")).toBe(100);
    expect(
      sqlite.database
        .prepare(
          "SELECT sync_cursor FROM connector_settings WHERE connector_id='binance'",
        )
        .get()?.sync_cursor,
    ).toBeNull();
  });
  it("commits matching settings versions and cursor atomically", async () => {
    const { db, env, sqlite } = setup();
    const setting = await updateConnectorSettings(env, "binance", {
      apiKey: "key",
      apiSecret: "secret",
    });
    await persistStagedSyncWrite(db, {
      records: records(100, "2026-09-23T00:00:00Z"),
      beforePromoteStatements: [
        exchangeSettingsGuard(db, "binance", setting.updatedAt),
      ],
      finalizeStatements: [
        connectorCursorStatement(db, "binance", "new-cursor", "new-version"),
      ],
    });
    expect(
      sqlite.database
        .prepare(
          "SELECT sync_cursor FROM connector_settings WHERE connector_id='binance'",
        )
        .get()?.sync_cursor,
    ).toBe("new-cursor");
  });
  it("creates all three disabled schedule jobs idempotently", () => {
    const { sqlite } = setup();
    const rows = sqlite.database
      .prepare(
        "SELECT connector_id, enabled FROM sync_jobs WHERE connector_id IN ('binance','bybit','okx') ORDER BY connector_id",
      )
      .all();
    expect(rows.map((row) => [row.connector_id, row.enabled])).toEqual([
      ["binance", 0],
      ["bybit", 0],
      ["okx", 0],
    ]);
  });
});
