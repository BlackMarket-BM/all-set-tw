import type {
  ScheduledSyncReport,
  SyncActivityDetailsPage,
  ConnectorId,
} from "@taiwan-fin-hub/core";
import { queryOptions, infiniteQueryOptions } from "@tanstack/svelte-query";
import type { ApiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/query-keys";

type ApiProvider = () => ApiClient;

export const latestSyncReportQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.latestSyncReport,
    queryFn: () =>
      getApi().get<ScheduledSyncReport | null>("/api/sync-reports/latest"),
  });

export const syncActivityDetailsQuery = (
  getApi: ApiProvider,
  batchId: string,
  connectorId: ConnectorId,
  revision: string,
  enabled: boolean,
) =>
  infiniteQueryOptions({
    queryKey: ["sync-reports", batchId, connectorId, "activities", revision],
    initialPageParam: 0,
    enabled,
    queryFn: ({ pageParam }) =>
      getApi().get<SyncActivityDetailsPage>(
        `/api/sync-reports/${encodeURIComponent(batchId)}/sources/${connectorId}/activities?offset=${pageParam}&asOf=${encodeURIComponent(revision)}`,
      ),
    getNextPageParam: (page: SyncActivityDetailsPage) =>
      page.nextOffset ?? undefined,
  });
