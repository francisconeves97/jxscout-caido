<script setup lang="ts">
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import { computed, ref, watch } from "vue";

import StatusCard from "@/components/StatusCard.vue";
import { useJxscoutStatus } from "@/composables/useJxscoutStatus";
import { useLicense } from "@/composables/useLicense";
import { useSettings } from "@/composables/useSettings";

const { settings, isLoading, save } = useSettings();
const { isPro } = useLicense();
const { status } = useJxscoutStatus();

const showStatusCard = computed(() => isPro.value && status.value !== null);

const host = ref(settings.value.host);
const port = ref<number | null>(settings.value.port);
const filterInScope = ref(settings.value.filterInScope);

watch(
  settings,
  (next) => {
    host.value = next.host;
    port.value = next.port;
    filterInScope.value = next.filterInScope;
  },
  { deep: true }
);

const onSave = async () => {
  if (port.value === null || !Number.isFinite(port.value)) {
    return;
  }
  await save({
    host: host.value,
    port: port.value,
    filterInScope: filterInScope.value,
  });
};
</script>

<template>
  <div class="flex flex-col gap-3">
    <StatusCard v-if="showStatusCard" />
    <div class="flex flex-col gap-1">
      <label
        for="jxscout-host"
        class="text-sm font-medium text-surface-700 dark:text-surface-200"
        >Host</label
      >
      <InputText
        id="jxscout-host"
        v-model="host"
        placeholder="localhost"
        :disabled="isLoading"
        fluid
      />
    </div>

    <div class="flex flex-col gap-1">
      <label
        for="jxscout-port"
        class="text-sm font-medium text-surface-700 dark:text-surface-200"
        >Port</label
      >
      <InputNumber
        id="jxscout-port"
        v-model="port"
        :use-grouping="false"
        :min="1"
        :max="65535"
        placeholder="3333"
        :disabled="isLoading"
        fluid
      />
    </div>

    <div class="flex items-center gap-2 pt-1">
      <Checkbox
        input-id="jxscout-filter"
        v-model="filterInScope"
        binary
        :disabled="isLoading"
      />
      <label
        for="jxscout-filter"
        class="text-sm text-surface-700 dark:text-surface-200 select-none cursor-pointer"
        >Filter in scope</label
      >
    </div>

    <div class="flex justify-end pt-2">
      <Button
        label="Save Settings"
        :disabled="isLoading"
        :loading="isLoading"
        @click="onSave"
      />
    </div>
  </div>
</template>
