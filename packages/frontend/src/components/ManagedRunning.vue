<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";

import AutoSyncPill from "@/components/AutoSyncPill.vue";
import ManagedSettings from "@/components/ManagedSettings.vue";
import ProjectPicker from "@/components/ProjectPicker.vue";
import ScopeSettings from "@/components/ScopeSettings.vue";
import { useBinary } from "@/composables/useBinary";
import { useJxscoutStatus } from "@/composables/useJxscoutStatus";
import { useManualProject } from "@/composables/useManualProject";
import { useSettings } from "@/composables/useSettings";
import { useSupervisor } from "@/composables/useSupervisor";
import { useSDK } from "@/plugins/sdk";

const sdk = useSDK();
const { snapshot, uptimeMs, isBusy, stop, restart } = useSupervisor();
const { status } = useJxscoutStatus();
const { settings } = useSettings();
const manualProject = useManualProject();
const binary = useBinary();

// Phase 10: Auto-sync OFF -> show the picker; ON -> static text. Plan default
// keeps the picker out of the user's way when auto-sync is doing the work.
const autoSyncOff = computed(() => settings.value.autoSync === false);
const hasManualOverride = computed(
  () =>
    typeof manualProject.manualProjectName.value === "string" &&
    manualProject.manualProjectName.value.trim().length > 0
);

// Status data comes from the same /health poll that Manual mode uses. In
// Managed mode the supervisor binds 127.0.0.1:<port>; settings.host defaults
// to "localhost" + settings.port is persisted to the chosen port, so the
// poller resolves to the right place without any Managed-specific plumbing.
// Until /health responds (the ~400ms gap between supervisor 'running' and
// the first successful poll) status is null and meta rows show "—".

const uptimeLabel = computed(() => {
  const ms = uptimeMs.value;
  if (ms === null) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
});

const versionLabel = computed(() =>
  status.value?.version ? `v${status.value.version}` : null
);

const onStop = async () => {
  const r = await stop();
  if (!r.success) {
    sdk.window.showToast(`Failed to stop: ${r.error}`, { variant: "error" });
  }
};

const onRestart = async () => {
  const r = await restart();
  if (!r.success) {
    sdk.window.showToast(`Failed to restart: ${r.error}`, {
      variant: "error",
    });
  }
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
  <div class="flex min-w-0 flex-col gap-3">
    <AutoSyncPill />

    <div
      class="flex min-w-0 flex-col gap-3 rounded-md border border-surface-600 bg-surface-800 p-3 ring-1 ring-success-500/30"
    >
      <div class="flex items-center justify-between gap-2">
        <span
          class="inline-flex items-center gap-1.5 rounded-full bg-success-500/15 px-2 py-0.5 text-xs font-medium text-success-300"
        >
          <span
            class="inline-block h-1.5 w-1.5 rounded-full bg-success-500"
            aria-hidden="true"
          ></span>
          Running
        </span>
        <span class="text-xs text-surface-500 dark:text-surface-400">
          uptime {{ uptimeLabel }}<template v-if="versionLabel">
            · {{ versionLabel }}</template>
        </span>
      </div>

      <!-- Meta grid mirrors the C2 / C3 prototype: Project / Working dir /
           Binary path. Long paths use [overflow-wrap:anywhere] so they break
           inside the right-hand column without expanding the grid.
           Placeholder dashes are rendered in the default font (not <code>)
           so they line up visually with the Project row's dash; the <code>
           element is only used when there's an actual path to display. -->
      <div class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <span class="text-surface-500 dark:text-surface-400">Project:</span>
        <ProjectPicker
          v-if="autoSyncOff"
          :current-name="status?.project ?? null"
          :has-manual-override="hasManualOverride"
        />
        <span
          v-else
          class="min-w-0 break-all text-surface-700 dark:text-surface-200"
        >
          {{ status?.project ?? "—" }}
        </span>
        <span class="text-surface-500 dark:text-surface-400">Working dir:</span>
        <div v-if="status?.working_directory" class="min-w-0 flex flex-col gap-1">
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
          class="text-surface-700 dark:text-surface-200"
          >—</span
        >
        <span class="text-surface-500 dark:text-surface-400">Binary:</span>
        <code
          v-if="binary.detection.value?.path"
          class="block min-w-0 break-all font-mono text-xs text-surface-700 dark:text-surface-200 [overflow-wrap:anywhere]"
          >{{ binary.detection.value.path }}</code
        >
        <span
          v-else
          class="text-surface-700 dark:text-surface-200"
          >—</span
        >
        <span class="text-surface-500 dark:text-surface-400">PID / port:</span>
        <span class="font-mono text-surface-700 dark:text-surface-200">
          {{ snapshot?.pid ?? "—" }} · {{ snapshot?.port ?? "—" }}
        </span>
      </div>

      <div class="flex justify-end gap-2">
        <Button
          label="Restart"
          severity="secondary"
          text
          size="small"
          :loading="isBusy"
          @click="onRestart"
        />
        <Button
          label="Stop"
          severity="secondary"
          size="small"
          :loading="isBusy"
          @click="onStop"
        />
      </div>
    </div>

    <ScopeSettings />

    <ManagedSettings />
  </div>
</template>
