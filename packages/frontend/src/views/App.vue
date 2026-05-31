<script setup lang="ts">
import type { Mode } from "backend";
import { computed, onMounted, ref, watch } from "vue";

import ConfirmModeSwitchDialog from "@/components/ConfirmModeSwitchDialog.vue";
import ModeCards from "@/components/ModeCards.vue";
import { provideAutoSync } from "@/composables/useAutoSync";
import { provideBinary } from "@/composables/useBinary";
import { provideJxscoutProjects } from "@/composables/useJxscoutProjects";
import { provideJxscoutStatus } from "@/composables/useJxscoutStatus";
import { provideLicense } from "@/composables/useLicense";
import { provideManualProject } from "@/composables/useManualProject";
import { provideScope } from "@/composables/useScope";
import { provideSettings } from "@/composables/useSettings";
import { provideSupervisor } from "@/composables/useSupervisor";
import { useSDK } from "@/plugins/sdk";
import ManagedView from "./ManagedView.vue";
import ManualView from "./ManualView.vue";

const sdk = useSDK();
const settingsState = provideSettings();
const licenseState = provideLicense();

const mode = computed<Mode>(() => settingsState.settings.value.mode);

// Supervisor gate is narrower than the status gate: only fire when the user
// is Pro AND in managed mode. The supervisor backend never spawns at init
// (orphan recovery aside), so this is purely a UI subscription gate -- free /
// manual users don't even attach the event listener.
const supervisorEnabled = computed(
  () =>
    licenseState.isPro.value &&
    settingsState.isLoaded.value &&
    mode.value === "managed"
);
const supervisorState = provideSupervisor(supervisorEnabled);

// Gate the /health poll: only run when settings are loaded (so we never poll
// the default 3333 before the user's saved port is read) and the user is Pro
// (free users have no status card to render).
const statusEnabled = computed(
  () => licenseState.isPro.value && settingsState.isLoaded.value
);

// In managed mode the supervisor auto-allocates its own port at start --
// the live value lives in snapshot.port, NOT in settings.json (which is
// shared across parallel Caido instances and intentionally has no managed
// port preference). Manual mode keeps using settings.port as the
// user-configured connection target.
const statusPortOverride = computed<number | null>(() => {
  if (mode.value !== "managed") return null;
  return supervisorState.snapshot.value?.port ?? null;
});
provideJxscoutStatus(settingsState.settings, statusEnabled, statusPortOverride);

// Binary detection has the same gate as supervisor: Pro + managed mode.
// Free + Manual users never need it. Phase 5 RPCs collapse failures into a
// typed result so detection itself is safe to call from this layer.
provideBinary(supervisorEnabled);

// Scope state: fetches the current jxscout project's scope on every
// supervisor->running transition so ScopeSettings can populate its textareas
// from the new project rather than carrying patterns over from the previous
// one. Save still pushes via POST /scope. Pass the resolved state in (rather
// than re-injecting) because Vue's inject() during App.vue's setup can't see
// provides registered on the same instance.
provideScope(supervisorState);

// Phase 8: auto-sync events (project switch / project closed). Same gate as
// supervisor -- only subscribe when Pro + managed.
provideAutoSync(supervisorEnabled);

// Phase 10: lazy project-list cache for the manual project picker. No gate
// here -- the composable is dormant until a consumer calls refresh() or
// fetchIfStale(). ProjectPicker is only mounted on ManagedRunning when
// !autoSync, so in practice only Pro + managed + running users ever hit it.
provideJxscoutProjects();

// Phase 10: manual project name. Per-Caido-process state (the backend keeps
// it in module-scope memory only, never in settings.json) so two Caido
// instances sharing the same Data dir can each pick their own project.
provideManualProject();

// Phase 9: Managed -> Manual while the supervisor is mid-spawn or running
// requires user confirmation. Without it, flipping mode leaves the child
// alive as an orphan -- it survives the mode flip and gets cleaned up only
// at the next plugin init (recoverOrphan). The dialog gives three explicit
// outcomes: stop the child, keep it running (treat as Manual external jxscout),
// or cancel and stay in Managed mode.
//
// 'failed' is intentionally NOT included: the child is already gone, so the
// switch is non-destructive. 'stopped' is excluded for the same reason.
const isSupervisorActive = computed(() => {
  const s = supervisorState.snapshot.value?.state;
  return s === "starting" || s === "running";
});

const pendingSwitch = ref<Mode | null>(null);
const confirmDialogOpen = computed(() => pendingSwitch.value !== null);

const onSelectMode = async (next: Mode) => {
  if (next === mode.value) return;
  if (next === "manual" && isSupervisorActive.value) {
    pendingSwitch.value = next;
    return;
  }
  await settingsState.save({ mode: next });
};

const onConfirmChoice = async (choice: "stop" | "keep" | "cancel") => {
  const next = pendingSwitch.value;
  pendingSwitch.value = null;
  if (next === null || choice === "cancel") return;
  if (choice === "stop") {
    // Intent ("did the user want jxscout running?") lives in module-scope
    // memory on the backend now, not in settings.json -- the supervisor
    // stop() call updates it, so we only need to flip the mode here.
    await supervisorState.stop();
    await settingsState.save({ mode: next });
    return;
  }
  // 'keep': leave intent alone (the supervisor is still running). The user
  // gets jxscout staying up under Manual mode as an externally-managed
  // process.
  await settingsState.save({ mode: next });
};

// Phase 9: license-removed external detection. useLicense.refresh() runs on
// every window-focus event; when the user removes ~/.jxscout-pro/.license
// (or jxscout-pro-v2 clears it on a Keygen heartbeat failure) and refocuses
// Caido, isPro flips true -> false. We respond with a one-shot toast plus a
// supervisor stop if it was running.
//
// Skipping the initial false -> true transition: licenseState starts at
// isPro=false, isLoaded=false. The first refresh() in onMounted lands it at
// isPro=<truth>, isLoaded=true. We only care about transitions AFTER the
// first authoritative read, so we gate on a sticky `licenseEverLoaded` flag.
const licenseEverLoaded = ref(false);
watch(
  [licenseState.isPro, licenseState.isLoaded],
  ([isPro, isLoaded], previous) => {
    if (!isLoaded) return;
    if (!licenseEverLoaded.value) {
      licenseEverLoaded.value = true;
      return;
    }
    const wasPro = previous?.[0] ?? false;
    if (wasPro && !isPro) {
      sdk.window.showToast("License removed — back to Manual mode", {
        variant: "info",
      });
      // supervisorState.stop() routes through stopJxscoutHandler, which
      // flips the module-scope intended state to "stopped" before killing
      // the child. Across a Caido restart that intent is lost (it lived in
      // memory), so re-adding the license + restarting Caido will see
      // auto-launch fire again -- intentional, to avoid stale gates.
      const s = supervisorState.snapshot.value?.state;
      if (s === "starting" || s === "running") {
        void supervisorState.stop();
      }
    }
  }
);

onMounted(async () => {
  await Promise.all([settingsState.load(), licenseState.refresh()]);
});
</script>

<template>
  <!-- Caido's host gives the plugin root height:100%; without overflow-y:auto
       on this scroll container any content that doesn't fit the viewport gets
       clipped silently (Phase 8 introduced enough Advanced-settings rows that
       the Managed view now exceeds typical viewport heights). h-full pins the
       scroll container to the plugin's allocated height; the inner div keeps
       the existing max-w-md + gap-3 layout intact. -->
  <div class="h-full overflow-y-auto">
    <div class="flex min-w-0 flex-col gap-3 p-3 max-w-md">
      <p class="m-0 text-sm text-surface-500 dark:text-surface-400">
        Choose how Caido connects to jxscout.
      </p>

      <ModeCards
        :mode="mode"
        :is-pro="licenseState.isPro.value"
        :disabled="settingsState.isLoading.value"
        @select="onSelectMode"
      />

      <ManualView v-if="mode === 'manual'" />
      <ManagedView v-else />
    </div>

    <ConfirmModeSwitchDialog
      :open="confirmDialogOpen"
      @choice="onConfirmChoice"
    />
  </div>
</template>
