<script lang="ts">
  import { formatCurrency } from "@/shared/format/financial";
  import type { ActivityCategorySlice, ActivityFlow } from "../model/chart";

  let {
    flow,
    slices,
    selectedCategory,
    flowSelected,
    dataIncomplete = false,
    onSelect,
    onSelectFlow,
  }: {
    flow: ActivityFlow;
    slices: ActivityCategorySlice[];
    selectedCategory?: string;
    flowSelected: boolean;
    dataIncomplete?: boolean;
    onSelect: (category: string) => void;
    onSelectFlow: () => void;
  } = $props();

  const title = $derived(flow === "income" ? "收入分類" : "支出分類");
  const flowLabel = $derived(flow === "income" ? "收入" : "支出");
  const total = $derived(slices.reduce((sum, slice) => sum + slice.amount, 0));
</script>

<section class="min-w-0">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h3
        class={`text-base font-semibold ${flow === "income" ? "text-moss" : "text-coral"}`}
      >
        {title}
      </h3>
      <p class="mt-1 text-caption text-subtle">點選分類查看該月活動</p>
    </div>
    <button
      type="button"
      aria-label={flowSelected ? "顯示全部活動" : `查看${flowLabel}活動`}
      aria-pressed={flowSelected}
      class="min-h-11 shrink-0 rounded-sm px-1 text-right transition hover:bg-ink/3"
      onclick={onSelectFlow}
    >
      <p
        class={`text-lg font-medium tracking-tight tabular-nums ${flow === "income" ? "text-moss" : "text-coral"}`}
      >
        {#if dataIncomplete}—{:else}{flow === "income"
            ? "+"
            : "−"}{formatCurrency(total)}{/if}
      </p>
      <p class="mt-1 text-xs text-subtle">
        {flowSelected ? "顯示全部" : `查看${flowLabel}`}
      </p>
    </button>
  </div>
  <div class="pt-4">
    {#if dataIncomplete}
      <p class="py-8 text-center text-sm text-subtle">
        活動資料尚未完整載入，分類比例暫不計算。
      </p>
    {:else if slices.length === 0}
      <p class="py-8 text-center text-sm text-subtle">
        此月份沒有{flow === "income" ? "收入" : "支出"}活動
      </p>
    {:else}
      <div class="grid min-w-0 gap-1.5">
        {#each slices as slice (slice.category)}
          <button
            aria-pressed={selectedCategory === slice.category}
            class={`grid min-h-11 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-sm py-1 text-left transition ${selectedCategory === slice.category ? "bg-ink/4 shadow-[inset_3px_0_0_var(--color-steel)]" : "hover:bg-ink/3"}`}
            onclick={() => onSelect(slice.category)}
          >
            <span class="truncate text-sm font-semibold">{slice.category}</span>
            <span class="text-right">
              <span class="block text-caption font-medium tabular-nums"
                >{slice.percentage.toFixed(1)}%</span
              >
              <span class="block text-xs text-subtle tabular-nums"
                >{formatCurrency(slice.amount)}</span
              >
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</section>
