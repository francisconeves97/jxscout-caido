<script setup lang="ts">
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { computed, ref } from "vue";

import { useLicense } from "@/composables/useLicense";
import { useSettings } from "@/composables/useSettings";
import { useSDK } from "@/plugins/sdk";

const sdk = useSDK();
const license = useLicense();
const settingsState = useSettings();

const key = ref("");
const isSaving = ref(false);

const canSave = computed(() => key.value.trim().length > 0 && !isSaving.value);

const onBack = async () => {
  await settingsState.save({ mode: "manual" });
};

const onSave = async () => {
  if (!canSave.value) return;
  isSaving.value = true;
  try {
    const response = await sdk.backend.setLicense(key.value.trim());
    if (response.success) {
      key.value = "";
      sdk.window.showToast("License saved", { variant: "success" });
      await license.refresh();
    } else {
      sdk.window.showToast(`Failed to save license: ${response.error}`, {
        variant: "error",
      });
    }
  } catch (err) {
    sdk.window.showToast(`Failed to save license: ${err}`, {
      variant: "error",
    });
  } finally {
    isSaving.value = false;
  }
};
</script>

<template>
  <div
    class="flex flex-col gap-3 rounded-md border border-surface-600 bg-surface-800 p-4"
  >
    <div>
      <h3
        class="m-0 text-sm font-semibold text-surface-800 dark:text-white/80"
      >
        Activate JXScout Pro
      </h3>
      <p
        class="m-0 mt-1 text-sm text-surface-500 dark:text-surface-400 leading-snug"
      >
        Paste your license key below. The key is stored at
        <code class="font-mono">~/.jxscout-pro/.license</code>.
      </p>
    </div>

    <div class="flex flex-col gap-1">
      <label
        for="jxscout-license-key"
        class="text-sm font-medium text-surface-700 dark:text-surface-200"
        >License key</label
      >
      <InputText
        id="jxscout-license-key"
        v-model="key"
        class="box-border font-mono"
        placeholder="Paste here…"
        :disabled="isSaving"
        fluid
        @keydown.enter="onSave"
      />
    </div>

    <p class="m-0 text-sm text-surface-500 dark:text-surface-400 leading-snug">
      Don't have one? Get a license at
      <a
        href="https://jxscout.app/"
        target="_blank"
        rel="noopener noreferrer"
        class="text-info-400 hover:underline"
        >jxscout.app</a
      >.
    </p>

    <div class="flex items-center justify-between pt-1">
      <Button
        label="Back to Manual"
        severity="secondary"
        text
        :disabled="isSaving || settingsState.isLoading.value"
        @click="onBack"
      />
      <Button
        label="Save license"
        severity="warn"
        :disabled="!canSave"
        :loading="isSaving"
        @click="onSave"
      />
    </div>
  </div>
</template>
