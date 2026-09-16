import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@/shared/api/client";
import { moneyState } from "@/shared/state/money-visibility.svelte";
import SyncActivityDetails from "./SyncActivityDetails.svelte";

function setup(get: ReturnType<typeof vi.fn>) {
  return render(
    SyncActivityDetails,
    {
      props: {
        api: { get } as unknown as ApiClient,
        batchId: "default:batch",
        connectorId: "sinopac",
        revision: "v1",
      },
    },
    {
      wrapper: QueryClientProvider,
      wrapperProps: {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
    },
  );
}
const item = {
  id: "t1",
  title: "全聯福利中心",
  subtitle: "永豐銀行",
  date: "2026-09-01",
  syncedAt: "2026-09-15T06:00:00Z",
  amount: -358,
  currency: "TWD",
  status: "pending",
  changes: ["added"],
};
describe("本次同步明細", () => {
  it("展開才讀取、可分頁且收合不重複取得", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        availability: "available",
        items: [item],
        nextOffset: 30,
      })
      .mockResolvedValueOnce({
        availability: "available",
        items: [{ ...item, id: "t2", title: "台灣高鐵" }],
        nextOffset: null,
      });
    const ui = setup(get);
    expect(get).not.toHaveBeenCalled();
    await fireEvent.click(ui.getByRole("button", { name: "查看本次活動" }));
    await ui.findByText("全聯福利中心");
    expect(get).toHaveBeenCalledWith(
      "/api/sync-reports/default%3Abatch/sources/sinopac/activities?offset=0&asOf=v1",
    );
    await fireEvent.click(ui.getByRole("button", { name: "載入更多" }));
    await ui.findByText("台灣高鐵");
    expect(get).toHaveBeenLastCalledWith(
      "/api/sync-reports/default%3Abatch/sources/sinopac/activities?offset=30&asOf=v1",
    );
    await fireEvent.click(ui.getByRole("button", { name: "收合本次活動" }));
    expect(ui.queryByText("全聯福利中心")).not.toBeInTheDocument();
  });
  it("明細載入失敗可重試，舊報告不顯示成零變動", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        availability: "legacy",
        items: [],
        nextOffset: null,
      });
    const ui = setup(get);
    await fireEvent.click(ui.getByRole("button", { name: "查看本次活動" }));
    await ui.findByText("無法載入同步明細。");
    await fireEvent.click(ui.getByRole("button", { name: "重試" }));
    await ui.findByText("此報告僅提供筆數，沒有保存活動明細。");
    expect(
      ui.queryByText("本次沒有新增活動、入帳或補上發票。"),
    ).not.toBeInTheDocument();
  });
  it("隱藏金額涵蓋新增的明細", async () => {
    moneyState.hidden = true;
    try {
      const ui = setup(
        vi.fn().mockResolvedValue({
          availability: "available",
          items: [item],
          nextOffset: null,
        }),
      );
      await fireEvent.click(ui.getByRole("button", { name: "查看本次活動" }));
      await ui.findByText("••••••");
      await waitFor(() =>
        expect(ui.queryByText(/358/)).not.toBeInTheDocument(),
      );
    } finally {
      moneyState.hidden = false;
    }
  });
});
