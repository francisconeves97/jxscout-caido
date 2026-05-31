<script setup lang="ts">
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";

import BinarySetup from "@/components/BinarySetup.vue";
import { useBinary } from "@/composables/useBinary";
import { useSettings } from "@/composables/useSettings";
import { useSDK } from "@/plugins/sdk";

const sdk = useSDK();
const settingsState = useSettings();
const binary = useBinary();

const isOpen = ref(false);
const showBinaryEdit = ref(false);
const dirInput = ref(settingsState.settings.value.defaultProjectsDir ?? "");
const isSaving = ref(false);

// Phase 8 toggles. v-model'd onto reactive settings; the @update handlers fire
// the save RPC + handle the "off -> on" intent reset for autoLaunch.
const autoLaunchOn = computed(() => settingsState.settings.value.autoLaunch);
const autoSyncOn = computed(() => settingsState.settings.value.autoSync);

const onAutoLaunchToggle = async (next: boolean) => {
  await settingsState.save({ autoLaunch: next });
};

const onAutoSyncToggle = async (next: boolean) => {
  await settingsState.save({ autoSync: next });
};

// Keep the input synced with on-disk state when settings reload (e.g. after
// an out-of-band save). Won't fight user input -- the watcher only fires
// when the underlying ref changes.
watch(
  () => settingsState.settings.value.defaultProjectsDir,
  (next) => {
    dirInput.value = next ?? "";
  }
);

const onSaveProjectsDir = async () => {
  isSaving.value = true;
  try {
    const trimmed = dirInput.value.trim();
    const ok = await settingsState.save({
      defaultProjectsDir: trimmed.length === 0 ? null : trimmed,
    });
    if (ok) {
      sdk.window.showToast("Default projects directory saved", {
        variant: "success",
      });
    }
  } finally {
    isSaving.value = false;
  }
};

const onChangeBinary = () => {
  showBinaryEdit.value = true;
};

const onBinaryEditBack = () => {
  showBinaryEdit.value = false;
};

const onClearCustomPath = async () => {
  const response = await sdk.backend.clearCustomBinaryPath();
  if (response.success) {
    sdk.window.showToast("Custom binary path cleared", {
      variant: "success",
    });
    await Promise.all([settingsState.load(), binary.refresh()]);
  } else {
    sdk.window.showToast(`Failed: ${response.error}`, { variant: "error" });
  }
};
</script>

<template>
  <details
    class="rounded-md border border-surface-600 bg-surface-800"
    :open="isOpen"
    @toggle="
      isOpen = ($event.target as HTMLDetailsElement).open;
      if (isOpen) void binary.refresh();
    "
  >
    <summary
      class="cursor-pointer select-none px-3 py-2 text-sm font-medium text-surface-700 dark:text-surface-200"
    >
      Advanced settings
    </summary>

    <div
      v-if="!showBinaryEdit"
      class="flex min-w-0 flex-col gap-4 border-t border-surface-700 px-3 py-3"
    >
      <div class="flex min-w-0 flex-col gap-1">
        <label
          for="jxscout-default-projects-dir"
          class="text-sm font-medium text-surface-700 dark:text-surface-200"
          >Default projects directory</label
        >
        <InputText
          id="jxscout-default-projects-dir"
          v-model="dirInput"
          class="box-border font-mono"
          placeholder="~/jxscout-pro (default)"
          :disabled="isSaving"
          fluid
        />
        <div class="flex justify-end pt-1">
          <Button
            label="Save"
            severity="secondary"
            size="small"
            :loading="isSaving"
            @click="onSaveProjectsDir"
          />
        </div>
      </div>

      <div class="flex min-w-0 flex-col gap-3 border-t border-surface-700 pt-3">
        <!-- Auto-launch toggle. Aligned label + switch with a hint below. -->
        <div class="flex min-w-0 flex-col gap-1">
          <label
            for="jxscout-auto-launch"
            class="flex items-center justify-between gap-3"
          >
            <span
              class="text-sm font-medium text-surface-700 dark:text-surface-200"
              >Auto-launch</span
            >
            <ToggleSwitch
              input-id="jxscout-auto-launch"
              :model-value="autoLaunchOn"
              @update:model-value="onAutoLaunchToggle"
            />
          </label>
          <p
            class="m-0 text-xs text-surface-500 dark:text-surface-400 leading-snug"
          >
            Start jxscout when Caido opens — no need to visit this page.
          </p>
        </div>

        <!-- Auto-sync toggle. -->
        <div class="flex min-w-0 flex-col gap-1">
          <label
            for="jxscout-auto-sync"
            class="flex items-center justify-between gap-3"
          >
            <span
              class="text-sm font-medium text-surface-700 dark:text-surface-200"
              >Auto-sync</span
            >
            <ToggleSwitch
              input-id="jxscout-auto-sync"
              :model-value="autoSyncOn"
              @update:model-value="onAutoSyncToggle"
            />
          </label>
          <p
            class="m-0 text-xs text-surface-500 dark:text-surface-400 leading-snug"
          >
            Follow the current Caido project. Restarts jxscout with a new
            <code class="font-mono">--project-name</code> when you switch projects;
            stops jxscout when the Caido project is closed.
          </p>
        </div>
      </div>

      <div class="flex min-w-0 flex-col gap-1 border-t border-surface-700 pt-3">
        <span
          class="text-sm font-medium text-surface-700 dark:text-surface-200"
          >Binary path</span
        >
        <template
          v-if="binary.detection.value && binary.detection.value.source"
        >
          <p
            class="m-0 text-xs text-surface-500 dark:text-surface-400 leading-snug"
          >
            Current ({{ binary.detection.value.source }}):
          </p>
          <!-- Block-level <code> with [overflow-wrap:anywhere] so very long
               paths break at any character without expanding the flex column.
               The inline <code class="break-all"> approach didn't propagate to
               the surrounding <p>'s width calc and overflowed the card. -->
          <code
            class="block w-full min-w-0 break-all font-mono text-xs text-surface-500 dark:text-surface-400 leading-snug [overflow-wrap:anywhere]"
            >{{ binary.detection.value.path }}</code
          >
        </template>
        <p
          v-else
          class="m-0 text-xs text-surface-500 dark:text-surface-400 leading-snug"
        >
          No binary detected.
        </p>
        <div class="flex justify-end gap-2 pt-1">
          <Button
            v-if="settingsState.settings.value.customBinaryPath"
            label="Clear custom path"
            severity="secondary"
            text
            size="small"
            @click="onClearCustomPath"
          />
          <Button
            label="Change binary path…"
            severity="secondary"
            size="small"
            @click="onChangeBinary"
          />
        </div>
      </div>
    </div>

    <!-- Inline BIN-3, reused from BinarySetup. After a successful validate +
         save, BinarySetup refreshes binary state; we just close ourselves. -->
    <div v-else class="border-t border-surface-700 p-3">
      <BinarySetup initial-view="specify" @back="onBinaryEditBack" />
    </div>
  </details>
</template>
