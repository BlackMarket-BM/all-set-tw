<script lang="ts">
  let { title, body }: { title: string; body: string } = $props();
</script>

<section class="min-w-0 py-16" aria-live="polite">
  <h2 class="text-base font-semibold tracking-tight">{title}</h2>
  <p class="mt-2 max-w-prose text-caption text-subtle">{body}</p>
</section>
