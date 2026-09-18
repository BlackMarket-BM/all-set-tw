<script lang="ts">
  import { onMount } from "svelte";
  import {
    ArrowDownLeft,
    ArrowUpRight,
    ChevronDown,
    TrendingUp,
  } from "@lucide/svelte";
  import { LineChart } from "layerchart";
  import TabsList from "@/shared/ui/TabsList.svelte";
  import TabsTrigger from "@/shared/ui/TabsTrigger.svelte";
  import {
    ChartContainer,
    ChartTooltip,
    type ChartConfig,
  } from "@/shared/ui/chart";
  import {
    formatCompactTwd,
    formatCurrency,
    formatDate,
  } from "@/shared/format/financial";
  import {
    buildNetWorthChartData,
    getNetWorthComparison,
    getAvailableNetWorthAssets,
    NET_WORTH_COMPARISON_PERIODS,
    NET_WORTH_ASSET_SERIES,
    NET_WORTH_DEFAULT_ASSETS,
    type NetWorthAssetType,
    type NetWorthChartPoint,
    type NetWorthDisplayMode,
    type NetWorthComparisonPeriod,
    type NetWorthTimeframe,
  } from "../model/net-worth-chart";
  import type { NetWorthHistoryRow } from "@/data/assets/types";

  let {
    data = [],
    loading = false,
  }: { data?: NetWorthHistoryRow[]; loading?: boolean } = $props();

  const storageKey = "taiwan-fin-hub-net-worth-chart-included-assets";
  const timeframes: NetWorthTimeframe[] = ["1M", "3M", "6M", "1Y", "ALL"];
  const chartConfig: ChartConfig = {
    selectedTotal: { label: "淨資產", color: "#3e6f7c" },
    stock: { label: "股票/ETF", color: "#6574cd" },
    fund: { label: "基金", color: "#9b6bb0" },
    deposit: { label: "存款", color: "#3e6f7c" },
    manual: { label: "其他資產", color: "#b5853f" },
  };

  let includedAssets = $state<NetWorthAssetType[]>([
    ...NET_WORTH_DEFAULT_ASSETS,
  ]);
  let settingsOpen = $state(false);
  let timeframe = $state<NetWorthTimeframe>("1Y");
  let displayMode = $state<NetWorthDisplayMode>("sum");
  let comparisonPeriod = $state<NetWorthComparisonPeriod>("day");

  const availableAssets = $derived(getAvailableNetWorthAssets(data));
  const chartData = $derived(
    buildNetWorthChartData(data, includedAssets, timeframe),
  );
  const comparisonData = $derived(
    buildNetWorthChartData(data, includedAssets, "ALL"),
  );
  const firstValue = $derived(chartData[0]?.selectedTotal ?? 0);
  const latestValue = $derived(chartData.at(-1)?.selectedTotal ?? 0);
  const changeValue = $derived(latestValue - firstValue);
  const changePercent = $derived(
    firstValue === 0 ? 0 : (changeValue / Math.abs(firstValue)) * 100,
  );
  const comparison = $derived(
    getNetWorthComparison(comparisonData, comparisonPeriod),
  );
  const comparisonOption = $derived(
    NET_WORTH_COMPARISON_PERIODS.find(
      (option) => option.key === comparisonPeriod,
    ),
  );
  const chartSeries = $derived(
    displayMode === "sum"
      ? [
          {
            key: "selectedTotal",
            label: "淨資產",
            value: "selectedTotal",
            color: "var(--color-selectedTotal)",
          },
        ]
      : [
          ...NET_WORTH_ASSET_SERIES.filter(({ key }) =>
            includedAssets.includes(key),
          ).map(({ key, label }) => ({
            key,
            label,
            value: key,
            color: `var(--color-${key})`,
          })),
          {
            key: "selectedTotal",
            label: "總和",
            value: "selectedTotal",
            color: "var(--color-selectedTotal)",
            props: { "stroke-dasharray": "6 4", strokeWidth: 2.5 },
          },
        ],
  );

  onMount(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (!Array.isArray(saved)) return;
      const valid = saved.filter((value): value is NetWorthAssetType =>
        ["stock", "fund", "deposit", "manual"].includes(value),
      );
      if (valid.length) includedAssets = valid;
    } catch {
      /* keep defaults */
    }
  });

  function toggleAsset(asset: NetWorthAssetType) {
    if (!availableAssets.has(asset)) return;
    const next = includedAssets.includes(asset)
      ? includedAssets.filter((item) => item !== asset)
      : [...includedAssets, asset];
    if (next.length === 0) return;
    includedAssets = next;
    localStorage.setItem(storageKey, JSON.stringify(next));
  }

  function xValue(point: NetWorthChartPoint) {
    return new Date(`${point.date}T00:00:00`);
  }

  function formatAxisDate(value: unknown) {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("zh-TW", {
      month: "numeric",
      day: "numeric",
    }).format(date);
  }
</script>

{#snippet chartTooltip()}
  <ChartTooltip
    indicator={displayMode === "sum" ? "dot" : "line"}
    labelFormatter={(value) =>
      formatDate(value instanceof Date ? value.toISOString() : String(value))}
    valueFormatter={(value) => formatCurrency(Number(value))}
  />
{/snippet}

<section class="min-w-0 max-w-full" aria-label="資產走勢">
  <div class="grid gap-3 pb-3">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
      <h2 class="flex items-center gap-2 text-base font-semibold">
        <TrendingUp class="size-4 text-steel" />資產走勢
      </h2>
      {#if chartData.length > 0}
        <span
          class={`inline-flex items-center gap-1 py-1 text-caption font-semibold ${changeValue >= 0 ? "text-moss" : "text-coral"}`}
        >
          {#if changeValue >= 0}<ArrowUpRight
              class="size-3.5"
            />{:else}<ArrowDownLeft class="size-3.5" />{/if}
          {changePercent >= 0 ? "+" : ""}{changePercent.toFixed(1)}%
        </span>
      {/if}
    </div>
    <div class="flex flex-wrap items-start justify-between gap-x-2 gap-y-3">
      <div class="min-w-0">
        <TabsList
          class="grid h-11 grid-cols-5 border-0 bg-transparent p-0.5 text-caption"
        >
          {#each timeframes as option (option)}
            <TabsTrigger
              class="h-10 px-2.5 py-1 text-sm"
              active={timeframe === option}
              onclick={() => (timeframe = option)}
              >{option === "ALL" ? "全部" : option}</TabsTrigger
            >
          {/each}
        </TabsList>
      </div>
      <button
        type="button"
        aria-expanded={settingsOpen}
        aria-controls="net-worth-display-settings"
        onclick={() => (settingsOpen = !settingsOpen)}
        class="flex min-h-10 cursor-pointer items-center gap-1.5 text-caption text-subtle"
      >
        顯示設定 <ChevronDown
          class={`size-3.5 transition-transform ${settingsOpen ? "rotate-180" : ""}`}
        />
      </button>
      <div
        id="net-worth-display-settings"
        hidden={!settingsOpen}
        class="flex basis-full flex-wrap [&[hidden]]:hidden items-center justify-between gap-3 border-t border-ink/5 pt-3"
      >
        <div
          class="flex flex-wrap items-center gap-1.5"
          aria-label="資產類型篩選"
        >
          <span class="text-caption font-medium text-subtle">包含</span>
          {#each NET_WORTH_ASSET_SERIES as option (option.key)}
            {@const active = includedAssets.includes(option.key)}
            {@const available = availableAssets.has(option.key)}
            <button
              class={`flex items-center gap-1.5 rounded-md px-2 py-2 text-caption font-medium transition ${active && available ? "bg-ink/5 text-ink" : "bg-transparent text-subtle"} ${available ? "hover:bg-ink/5 hover:text-steel" : "cursor-not-allowed opacity-40"}`}
              disabled={!available}
              aria-pressed={active}
              onclick={() => toggleAsset(option.key)}
              ><span
                class="size-2 rounded-full"
                style={`background:${option.color}`}
              ></span>{option.label}</button
            >
          {/each}
        </div>
        <TabsList class="h-9 border-0 p-0.5 text-caption">
          {#each [{ key: "sum", label: "總和" }, { key: "breakdown", label: "分類" }] as option (option.key)}
            <TabsTrigger
              class="h-8 px-2 py-0.5 text-sm"
              active={displayMode === option.key}
              onclick={() => (displayMode = option.key as NetWorthDisplayMode)}
              >{option.label}</TabsTrigger
            >
          {/each}
        </TabsList>
      </div>
    </div>
  </div>
  <div class="min-w-0 overflow-hidden">
    {#if loading}
      <div class="flex h-64 items-center justify-center text-sm text-subtle">
        載入趨勢中…
      </div>
    {:else if chartData.length === 0}
      <div
        class="flex h-64 items-center justify-center rounded-lg bg-ink/2 text-sm text-subtle"
      >
        尚無淨資產歷史資料。
      </div>
    {:else}
      <ChartContainer
        config={chartConfig}
        class="h-60 min-h-60 w-full min-w-0 sm:h-72 sm:min-h-72"
      >
        <LineChart
          data={chartData}
          x={xValue}
          series={chartSeries}
          padding={{ top: 16, right: 18, bottom: 28, left: 48 }}
          yBaseline={null}
          yNice={true}
          axis={true}
          grid={false}
          tooltip={chartTooltip}
          props={{
            xAxis: {
              format: formatAxisDate,
              tickSpacing: 72,
              tickMarks: false,
            },
            yAxis: {
              format: (value: unknown) => formatCompactTwd(Number(value)),
              tickSpacing: 52,
              tickMarks: false,
              grid: true,
            },
            spline: { strokeWidth: 2.5 },
            highlight: { points: true, lines: true },
          }}
        />
      </ChartContainer>
      <div class="mt-2 flex min-w-0 flex-wrap items-center gap-3 pt-3">
        {#if displayMode === "breakdown"}
          <div class="flex flex-wrap gap-x-4 gap-y-2 text-caption text-subtle">
            <span class="inline-flex items-center gap-1.5"
              ><span class="w-4 border-t-2 border-dashed border-ink"
              ></span>總和</span
            >
            {#each NET_WORTH_ASSET_SERIES.filter( ({ key }) => includedAssets.includes(key) ) as item (item.key)}
              <span class="inline-flex items-center gap-1.5"
                ><span
                  class="size-2 rounded-full"
                  style={`background:${item.color}`}
                ></span>{item.label}</span
              >
            {/each}
          </div>
        {:else}
          <span class="text-caption text-subtle">已選資產的每日合計</span>
        {/if}
      </div>
      <details class="group mt-4 border-t border-ink/8 pt-3">
        <summary
          class="flex min-h-10 cursor-pointer list-none flex-wrap items-center justify-between gap-2 text-caption [&::-webkit-details-marker]:hidden"
        >
          <span class="text-subtle">
            {comparisonOption?.label ?? "較昨日"}
            <span class="ml-2 font-medium text-ink">
              {#if !comparison}尚無有效快照
              {:else if comparison.changeValue === 0}持平
              {:else}{comparison.changeValue > 0 ? "+" : ""}{formatCurrency(
                  comparison.changeValue,
                )}{/if}
            </span>
          </span>
          <span class="flex items-center gap-1.5 text-subtle"
            >比較明細 <ChevronDown
              class="size-3.5 transition-transform group-open:rotate-180"
            /></span
          >
        </summary>
        <div
          class="mt-3 grid min-w-0 gap-3 md:grid-cols-[auto_minmax(18rem,28rem)] md:items-start md:justify-between"
        >
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="shrink-0 text-caption font-semibold text-subtle"
              >比較</span
            >
            <TabsList class="grid h-9 grid-cols-3 border-0 p-0.5 text-caption">
              {#each NET_WORTH_COMPARISON_PERIODS as option (option.key)}
                <TabsTrigger
                  class="h-8 px-2 py-0.5 text-sm"
                  active={comparisonPeriod === option.key}
                  onclick={() => (comparisonPeriod = option.key)}
                  >{option.label}</TabsTrigger
                >
              {/each}
            </TabsList>
          </div>
          {#if comparison && comparisonOption}
            {@const comparisonSign = comparison.changeValue > 0 ? "+" : ""}
            <div class="grid min-w-0 gap-2 py-2 text-sm">
              <div
                class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3"
              >
                <span class="text-subtle">目前</span>
                <span
                  class="whitespace-nowrap text-right font-semibold tabular-nums sm:text-base"
                  >{formatCurrency(comparison.currentValue)}</span
                >
              </div>
              <div
                class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
              >
                <span class="min-w-0">
                  <span class="block font-medium text-subtle"
                    >{comparisonOption.label}</span
                  >
                  <span class="mt-0.5 block text-caption text-subtle">
                    {formatDate(comparison.previousDate)}
                  </span>
                </span>
                <span
                  class="whitespace-nowrap text-right font-semibold tabular-nums sm:text-base"
                  >{formatCurrency(comparison.previousValue)}</span
                >
              </div>
              <div
                class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-t border-ink/8 pt-1.5"
              >
                <span class="font-semibold text-subtle">變化</span>
                <span
                  class={`whitespace-nowrap text-right font-semibold tabular-nums sm:text-base ${comparison.changeValue > 0 ? "text-moss" : comparison.changeValue < 0 ? "text-coral" : "text-subtle"}`}
                >
                  {comparison.changeValue < 0
                    ? ""
                    : comparisonSign}{formatCurrency(comparison.changeValue)}
                  {#if comparison.changePercent !== null}
                    （{comparison.changePercent > 0
                      ? "+"
                      : comparison.changePercent < 0
                        ? "−"
                        : ""}{Math.abs(comparison.changePercent).toFixed(1)}%）
                  {/if}
                </span>
              </div>
            </div>
          {:else}
            <p class="text-caption text-subtle">
              尚無{comparisonOption?.label ?? "目標"}的有效快照
            </p>
          {/if}
        </div>
      </details>
    {/if}
  </div>
</section>
