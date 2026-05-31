<script setup lang="ts">
import Button from "primevue/button";
import { computed, onScopeDispose, ref } from "vue";

import { useJxscoutStatus } from "@/composables/useJxscoutStatus";
import { useSDK } from "@/plugins/sdk";

const sdk = useSDK();
const { status, lastChecked, isFetching, reconnect } = useJxscoutStatus();

// Drives the "last ping Xs" ticker; settle for 0.5s granularity so the
// number changes visibly without burning render cycles.
const now = ref(Date.now());
const tick = setInterval(() => {
  now.value = Date.now();
}, 500);
onScopeDispose(() => clearInterval(tick));

const lastPingLabel = computed(() => {
  if (lastChecked.value === null) return "—";
  const seconds = Math.max(0, (now.value - lastChecked.value) / 1000);
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
});

const onReconnect = () => {
  void reconnect();
};

// "Open in <tool>" buttons under the working-dir row. Each routes through the
// backend openPath RPC, which spawns the platform-native launcher (open /
// explorer / xdg-open) or the editor's `code`/`cursor` CLI helper. Surfacing
// the launch error as a toast helps users diagnose missing CLI installs.
const onOpenWorkingDir = async (tool: "folder" | "vscode" | "cursor") => {
  const dir = status.value?.working_directory;
  if (!dir) return;
  const result = await sdk.backend.openPath({ path: dir, tool });
  if (!result.success) {
    sdk.window.showToast(result.error, { variant: "error" });
  }
};
</script>

<template>
  <div
    v-if="status"
    class="flex flex-col gap-3 rounded-md border border-surface-600 bg-surface-800 p-3 ring-1 ring-success-500/30"
  >
    <div class="flex items-center justify-between gap-2">
      <span
        class="inline-flex items-center gap-1.5 rounded-full bg-success-500/15 px-2 py-0.5 text-xs font-medium text-success-300"
      >
        <span
          class="inline-block h-1.5 w-1.5 rounded-full bg-success-500"
          aria-hidden="true"
        ></span>
        Connected
      </span>
      <span class="text-xs text-surface-500 dark:text-surface-400">
        v{{ status.version }} · last ping {{ lastPingLabel }}
      </span>
    </div>

    <div class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      <span class="text-surface-500 dark:text-surface-400">Project:</span>
      <span class="truncate text-surface-700 dark:text-surface-200">
        {{ status.project }}
      </span>
      <span class="text-surface-500 dark:text-surface-400">Working dir:</span>
      <div v-if="status.working_directory" class="min-w-0 flex flex-col gap-1">
        <code
          class="block min-w-0 break-all font-mono text-xs text-surface-700 dark:text-surface-200 [overflow-wrap:anywhere]"
          >{{ status.working_directory }}</code
        >
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <button
            type="button"
            class="text-info-400 hover:underline"
            @click="onOpenWorkingDir('folder')"
          >
            Open folder
          </button>
          <span class="text-surface-500 dark:text-surface-400" aria-hidden="true">·</span>
          <button
            type="button"
            class="text-info-400 hover:underline"
            @click="onOpenWorkingDir('vscode')"
          >
            VS Code
          </button>
          <span class="text-surface-500 dark:text-surface-400" aria-hidden="true">·</span>
          <button
            type="button"
            class="text-info-400 hover:underline"
            @click="onOpenWorkingDir('cursor')"
          >
            Cursor
          </button>
        </div>
      </div>
      <span
        v-else
        class="truncate font-mono text-xs text-surface-700 dark:text-surface-200"
      >
        —
      </span>
    </div>

    <div class="flex justify-end">
      <Button
        label="Reconnect"
        severity="secondary"
        text
        size="small"
        :loading="isFetching"
        @click="onReconnect"
      />
    </div>
  </div>
</template>
