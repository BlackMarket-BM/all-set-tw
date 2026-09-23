import type { ExchangeId } from "@taiwan-fin-hub/connectors";

export function exchangeSettingsGuard(
  db: D1Database,
  id: ExchangeId,
  version: string,
) {
  // Invalid JSON aborts the entire promotion batch if credentials changed/deleted mid-sync.
  // Only the version is bound, never the encrypted credentials or plaintext secrets.
  return db
    .prepare(
      `SELECT json(CASE WHEN EXISTS (
    SELECT 1 FROM connector_settings WHERE connector_id = ? AND updated_at = ?
  ) THEN 'true' ELSE 'exchange-settings-changed' END)`,
    )
    .bind(id, version);
}
