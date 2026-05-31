<script setup lang="ts">
import { computed } from "vue";

import BinarySetup from "@/components/BinarySetup.vue";
import LicenseEntry from "@/components/LicenseEntry.vue";
import ManagedIdle from "@/components/ManagedIdle.vue";
import ManagedRunning from "@/components/ManagedRunning.vue";
import { useBinary } from "@/composables/useBinary";
import { useLicense } from "@/composables/useLicense";
import { useSupervisor } from "@/composables/useSupervisor";

// Phase 7 routing. The four branches stack from outermost gate to most
// specific running state:
//
//   !isPro                                                -> LicenseEntry
//   isPro && !binary                                      -> BinarySetup
//   isPro && binary && state === 'running'                -> ManagedRunning
//   isPro && binary && state ∈ {stopped, starting, failed} -> ManagedIdle
//
// Detection / supervisor refs both gate on `isPro && managed` upstream, so
// the loaded flags are false for free / Manual users. We hold the
// LicenseEntry view at the top of the chain regardless of the lower-state
// readiness -- license entry doesn't need detection or supervisor state.
const { isPro, isLoaded: licenseLoaded } = useLicense();
const { hasBinary, isLoaded: binaryLoaded } = useBinary();
const { snapshot, isLoaded: supervisorLoaded } = useSupervisor();

const state = computed(() => snapshot.value?.state ?? "stopped");
const isRunning = computed(() => state.value === "running");

// Show a thin "loading…" affordance only while the first detection / state
// reads are in flight. Avoids a flash of LicenseEntry / BinarySetup before
// the truth lands.
const initialChecksReady = computed(
  () =>
    licenseLoaded.value &&
    (!isPro.value || (binaryLoaded.value && supervisorLoaded.value))
);
</script>

<template>
  <LicenseEntry v-if="!isPro" />

  <div
    v-else-if="!initialChecksReady"
    class="rounded-md border border-surface-600 bg-surface-800 p-3 text-sm text-surface-500 dark:text-surface-400"
  >
    Loading managed jxscout…
  </div>

  <BinarySetup v-else-if="!hasBinary" />

  <ManagedRunning v-else-if="isRunning" />

  <ManagedIdle v-else />
</template>
