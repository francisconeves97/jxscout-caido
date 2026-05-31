<script setup lang="ts">
import { computed } from "vue";

import { useAutoSync } from "@/composables/useAutoSync";

// Phase 8: transient pill rendered above the Managed status card while an
// auto-sync action is in flight. Visible for ~1.5s after each `auto-sync`
// event the backend emits (`useAutoSync` owns the lifetime). Rendered in both
// ManagedRunning and ManagedIdle so it stays on screen across the supervisor
// stopped -> starting -> running cycle during a project switch.
const { event } = useAutoSync();

const label = computed(() => {
  const e = event.value;
  if (!e) return "";
  if (e.kind === "switching") return `Switching project → ${e.to}…`;
  return "Stopping jxscout — Caido project closed…";
});
</script>

<template>
  <div
    v-if="event !== null"
    class="flex items-center gap-2 rounded-md border border-surface-600 bg-surface-800 px-3 py-2 text-xs text-surface-700 dark:text-surface-200 ring-1 ring-secondary-500/30"
    role="status"
    aria-live="polite"
  >
    <span
      class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-secondary-400"
      aria-hidden="true"
    ></span>
    <span>{{ label }}</span>
  </div>
</template>
