<script setup lang="ts">
import Button from "primevue/button";
import Textarea from "primevue/textarea";
import { ref, watch } from "vue";

import { useScope } from "@/composables/useScope";
import { useSDK } from "@/plugins/sdk";

// User-managed scope: host glob patterns shown directly under the status card
// in Managed views so users can flip patterns quickly without digging into a
// drawer. Source of truth is jxscout's per-project settings.jsonc -- the
// composable fetches it on every supervisor->running transition (incl.
// project switch) and seeds the textareas. Save pushes back via POST /scope.
const sdk = useSDK();
const scope = useScope();

const manualInScopeText = ref("");
const manualOutOfScopeText = ref("");
const isSavingScope = ref(false);

// Hydrate the textareas from whichever scope the composable has fetched.
// Fires on first arrival and on every project switch (the composable clears
// the ref on supervisor->stopped and refills it on supervisor->running).
// `null` -> blank textareas, which is the right state both pre-fetch and
// when no supervisor is running.
watch(
  () => scope.fetchedScope.value,
  (next) => {
    manualInScopeText.value = next ? next.in_scope.join("\n") : "";
    manualOutOfScopeText.value = next ? next.out_of_scope.join("\n") : "";
  },
  { immediate: true }
);

const parsePatterns = (raw: string): string[] =>
  raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const onSaveManualScope = async () => {
  isSavingScope.value = true;
  try {
    const in_scope = parsePatterns(manualInScopeText.value);
    const out_of_scope = parsePatterns(manualOutOfScopeText.value);
    const pushed = await scope.pushPatterns(in_scope, out_of_scope);
    if (pushed) {
      sdk.window.showToast("Scope saved", { variant: "success" });
    }
  } finally {
    isSavingScope.value = false;
  }
};
</script>

<template>
  <div
    class="flex min-w-0 flex-col gap-3 rounded-md border border-surface-600 bg-surface-800 p-3"
  >
    <div class="flex min-w-0 flex-col gap-1">
      <label
        for="jxscout-manual-in-scope"
        class="text-sm font-medium text-surface-700 dark:text-surface-200"
        >in_scope</label
      >
      <Textarea
        id="jxscout-manual-in-scope"
        v-model="manualInScopeText"
        class="box-border font-mono"
        rows="3"
        placeholder="*.example.com&#10;api.example.com"
        :disabled="isSavingScope || scope.isFetching.value"
        fluid
      />
      <p
        class="m-0 text-xs text-surface-500 dark:text-surface-400 leading-snug"
      >
        Host glob patterns to process. One per line.
      </p>
    </div>
    <div class="flex min-w-0 flex-col gap-1">
      <label
        for="jxscout-manual-out-of-scope"
        class="text-sm font-medium text-surface-700 dark:text-surface-200"
        >out_of_scope</label
      >
      <Textarea
        id="jxscout-manual-out-of-scope"
        v-model="manualOutOfScopeText"
        class="box-border font-mono"
        rows="3"
        placeholder="cdn.example.com&#10;*.internal.com"
        :disabled="isSavingScope || scope.isFetching.value"
        fluid
      />
      <p
        class="m-0 text-xs text-surface-500 dark:text-surface-400 leading-snug"
      >
        Host glob patterns to exclude. One per line.
      </p>
    </div>
    <div class="flex justify-end pt-1">
      <Button
        label="Save scope"
        severity="secondary"
        size="small"
        :loading="isSavingScope"
        :disabled="scope.isFetching.value"
        @click="onSaveManualScope"
      />
    </div>
  </div>
</template>
