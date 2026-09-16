import {
  createDrizzle,
  syncActivityRuns,
  syncActivityChanges,
  syncActivityDetails,
  scheduledSyncBatchResults,
  scheduledSyncBatches,
} from "@taiwan-fin-hub/db";
import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type {
  SyncActivityDetailsPage,
  SyncActivityDetail,
} from "@taiwan-fin-hub/core";

export async function beginActivityRun(
  db: D1Database,
  id: string,
  batchId: string | null | undefined,
  connectorId: string,
) {
  if (!batchId) return;
  await createDrizzle(db)
    .insert(syncActivityRuns)
    .values({
      id,
      batchId,
      connectorId,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
}

/** Compose with the result/recovery CAS; never associate by timestamp. */
export function publishActivityRunStatement(
  db: D1Database,
  runId: string,
  batchId: string,
  connectorId: string,
) {
  return db
    .prepare(
      `UPDATE sync_activity_runs SET published = 1
    WHERE id = ? AND batch_id = ? AND connector_id = ? AND changes() = 1
      AND EXISTS (SELECT 1 FROM scheduled_sync_batch_results
        WHERE batch_id = ? AND connector_id = ? AND completed_at IS NOT NULL)`,
    )
    .bind(runId, batchId, connectorId, batchId, connectorId);
}

export async function listActivityReportRuns(db: D1Database, batchId: string) {
  return createDrizzle(db)
    .select()
    .from(syncActivityRuns)
    .where(
      and(
        eq(syncActivityRuns.batchId, batchId),
        eq(syncActivityRuns.published, 1),
      ),
    )
    .orderBy(asc(syncActivityRuns.createdAt), asc(syncActivityRuns.id))
    .all();
}
export async function listActivityChanges(db: D1Database, runId: string) {
  return createDrizzle(db)
    .select()
    .from(syncActivityChanges)
    .where(eq(syncActivityChanges.runId, runId))
    .all();
}
export async function saveActivityDetails(
  db: D1Database,
  runId: string,
  items: SyncActivityDetail[],
) {
  // Freeze the complete projection atomically; chunk JSON to bound each statement's payload.
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < items.length; offset += 100) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO sync_activity_details (run_id, activity_id, snapshot)
      SELECT ?, json_extract(value, '$.id'), value FROM json_each(?)`,
        )
        .bind(runId, JSON.stringify(items.slice(offset, offset + 100))),
    );
  }
  statements.push(
    db
      .prepare("UPDATE sync_activity_runs SET materialized = 1 WHERE id = ?")
      .bind(runId),
  );
  await db.batch(statements);
}
export async function getActivityDetailsPage(
  db: D1Database,
  batchId: string,
  connectorId: string,
  offset: number,
  asOf?: string,
): Promise<SyncActivityDetailsPage | null> {
  const orm = createDrizzle(db);
  const source = await orm
    .select({ batchId: scheduledSyncBatchResults.batchId })
    .from(scheduledSyncBatchResults)
    .innerJoin(
      scheduledSyncBatches,
      eq(scheduledSyncBatches.id, scheduledSyncBatchResults.batchId),
    )
    .where(
      and(
        eq(scheduledSyncBatchResults.batchId, batchId),
        eq(scheduledSyncBatchResults.connectorId, connectorId),
        isNotNull(scheduledSyncBatches.completedAt),
      ),
    )
    .get();
  if (!source) return null;
  const runs = (await listActivityReportRuns(db, batchId)).filter(
    (r) => r.connectorId === connectorId && (!asOf || r.createdAt <= asOf),
  );
  if (!runs.length)
    return { availability: "legacy", items: [], nextOffset: null };
  if (runs.some((r) => !r.materialized))
    return { availability: "pending", items: [], nextOffset: null };
  const rows = await orm
    .select({ snapshot: syncActivityDetails.snapshot })
    .from(syncActivityDetails)
    .innerJoin(
      syncActivityRuns,
      eq(syncActivityRuns.id, syncActivityDetails.runId),
    )
    .where(
      and(
        eq(syncActivityRuns.batchId, batchId),
        eq(syncActivityRuns.connectorId, connectorId),
        eq(syncActivityRuns.published, 1),
        eq(syncActivityRuns.materialized, 1),
        asOf ? lte(syncActivityRuns.createdAt, asOf) : undefined,
      ),
    )
    .orderBy(
      desc(syncActivityRuns.createdAt),
      desc(syncActivityRuns.id),
      desc(sql`json_extract(${syncActivityDetails.snapshot}, '$.date')`),
      asc(syncActivityDetails.activityId),
    )
    .limit(31)
    .offset(offset)
    .all();
  return {
    availability: "available",
    items: rows
      .slice(0, 30)
      .map((r) => JSON.parse(r.snapshot) as SyncActivityDetail),
    nextOffset: rows.length > 30 ? offset + 30 : null,
  };
}

export async function findActivityRunBatchId(db: D1Database, runId: string) {
  const run = await createDrizzle(db)
    .select({ batchId: syncActivityRuns.batchId })
    .from(syncActivityRuns)
    .where(eq(syncActivityRuns.id, runId))
    .get();
  return run?.batchId ?? null;
}

export async function findUnfinishedActivityReport(db: D1Database) {
  const row = await createDrizzle(db)
    .select({ batchId: syncActivityRuns.batchId })
    .from(syncActivityRuns)
    .innerJoin(
      scheduledSyncBatches,
      eq(scheduledSyncBatches.id, syncActivityRuns.batchId),
    )
    .where(
      and(
        eq(syncActivityRuns.published, 1),
        eq(syncActivityRuns.materialized, 0),
        isNotNull(scheduledSyncBatches.completedAt),
      ),
    )
    .orderBy(asc(syncActivityRuns.createdAt))
    .limit(1)
    .get();
  return row?.batchId;
}
