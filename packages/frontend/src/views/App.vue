<script setup lang="ts">
import Button from "primevue/button";
import InputText from "primevue/inputtext";

import { useSDK } from "@/plugins/sdk";

import { ref, onMounted } from "vue";

// Retrieve the SDK instance to interact with the backend
const sdk = useSDK();

const host = ref("");
const port = ref("");
const filterInScope = ref(false);
const isLoading = ref(false);

// Load settings from the backend
const loadSettings = async () => {
  isLoading.value = true;
  try {
    const response = await sdk.backend.getSettings();
    if (!response.success) {
      sdk.window.showToast(`Failed to load settings: ${response.error}`, { variant: "error" });
      return;
    }

    const settings = response.data;

    host.value = settings.host;
    port.value = settings.port;
    filterInScope.value = settings.filterInScope;
  } catch (error) {
    sdk.window.showToast(`Failed to load settings: ${error}`, { variant: "error" });
  } finally {
    isLoading.value = false;
  }
};

// Save settings to the backend
const onSaveClick = async () => {
  isLoading.value = true;
  try {
    await sdk.backend.saveSettings({
      host: host.value,
      port: parseInt(port.value),
      filterInScope: filterInScope.value,
    });
    alert("Settings saved successfully!");
  } catch (error) {
    console.error("Failed to save settings:", error);
  } finally {
    isLoading.value = false;
  }
};

// Load settings when the component is mounted
onMounted(() => {
  loadSettings();
});
</script>

<template>
  <div class="flex flex-col p-4 gap-4 max-w-sm">
    <div>
      <h1 class="text-xl font-bold">JXScout Settings</h1>
      <p class="text-sm text-gray-600">Configure ingestion from Caido to JXScout.</p>
    </div>
    <div class="flex flex-col gap-4">
      <div class="flex justify-between items-center">
        <label for="host">Host:</label>
        <InputText id="host" v-model="host" placeholder="Host" :disabled="isLoading" />
      </div>
      <div class="flex justify-between items-center">
        <label for="port">Port:</label>
        <InputText id="port" v-model="port" placeholder="Port" :disabled="isLoading" />
      </div>
      <div class="flex items-center justify-between">
        <label for="filter">Filter in scope:</label>
        <input id="filter" type="checkbox" v-model="filterInScope" :disabled="isLoading" />
      </div>
      <Button label="Save Settings" @click="onSaveClick" :disabled="isLoading" />
    </div>
  </div>
</template>