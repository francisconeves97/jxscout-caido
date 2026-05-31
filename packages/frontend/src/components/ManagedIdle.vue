<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";

import AutoSyncPill from "@/components/AutoSyncPill.vue";
import ManagedSettings from "@/components/ManagedSettings.vue";
import ScopeSettings from "@/components/ScopeSettings.vue";
import { useSupervisor } from "@/composables/useSupervisor";
import { useSDK } from "@/plugins/sdk";

const sdk = useSDK();
const { snapshot, isBusy, start } = useSupervisor();

const state = computed(() => snapshot.value?.state ?? "stopped");

const onStart = async () => {
  const r = await start();
  if (!r.success) {
    sdk.window.showToast(`Failed to start: ${r.error}`, { variant: "error" });
  }
};
</script>

<template>
  <div class="flex flex-col gap-3">
    <AutoSyncPill />

    <!-- Starting -->
    <div
      v-if="state === 'starting'"
      class="flex flex-col gap-3 rounded-md border border-surface-600 bg-surface-800 p-3"
    >
      <div class="flex items-center gap-2">
        <span
          class="inline-flex items-center gap-1.5 rounded-full bg-secondary-500/15 px-2 py-0.5 text-xs font-medium text-secondary-300"
        >
          <span
            class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-secondary-400"
            aria-hidden="true"
          ></span>
          Starting…
        </span>
        <span class="text-xs text-surface-500 dark:text-surface-400">
          waiting for /health
        </span>
      </div>
    </div>

    <!-- Failed -->
    <div
      v-else-if="state === 'failed'"
      class="flex flex-col gap-3 rounded-md border border-surface-600 bg-surface-800 p-3 ring-1 ring-red-500/30"
    >
      <div class="flex items-center justify-between gap-2">
        <span
          class="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-300"
        >
          <span
            class="inline-block h-1.5 w-1.5 rounded-full bg-red-500"
            aria-hidden="true"
          ></span>
          Failed
        </span>
      </div>
      <p
        v-if="snapshot?.lastError"
        class="m-0 break-words text-sm text-surface-700 dark:text-surface-200"
      >
        {{ snapshot.lastError }}
      </p>
      <div class="flex justify-end">
        <Button label="Retry" :loading="isBusy" @click="onStart" />
      </div>
    </div>

    <!-- Stopped (default / initial) -->
    <div
      v-else
      class="flex flex-col gap-3 rounded-md border border-surface-600 bg-surface-800 p-3"
    >
      <div class="flex items-center gap-2">
        <span
          class="inline-flex items-center gap-1.5 rounded-full bg-surface-700 px-2 py-0.5 text-xs font-medium text-surface-300"
        >
          <span
            class="inline-block h-1.5 w-1.5 rounded-full bg-surface-400"
            aria-hidden="true"
          ></span>
          Stopped
        </span>
      </div>
      <p class="m-0 text-sm text-surface-500 dark:text-surface-400">
        Spawn a managed <code>jxscout-pro-v2</code> on a free local port for
        the current Caido project.
      </p>
      <div class="flex justify-end">
        <Button label="Start" :loading="isBusy" @click="onStart" />
      </div>
    </div>

    <ScopeSettings />

    <ManagedSettings />
  </div>
</template>
