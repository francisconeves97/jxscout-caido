<script setup lang="ts">
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { computed, nextTick, ref, watch } from "vue";

import { useJxscoutProjects } from "@/composables/useJxscoutProjects";
import { useManualProject } from "@/composables/useManualProject";
import { useSupervisor } from "@/composables/useSupervisor";
import { useSDK } from "@/plugins/sdk";

// Phase 10: manual project picker (Auto-sync OFF only). Lives inline on the
// ManagedRunning card, replacing the static "Project: <name>" row. Click the
// project name to open the picker; pick an existing one OR type a new one;
// Apply -> setManualProject + restartJxscout.
//
// Free-form names are accepted as-is and normalized on the backend; jxscout-rs
// creates the project directory on first spawn for names it hasn't seen. The
// picker doesn't try to validate against the /projects list -- the list is a
// convenience, not a constraint.
//
// Closure semantics match ConfirmModeSwitchDialog: Esc + click-outside both
// dismiss without applying. Default focus on the search input so the user can
// start typing immediately.

const props = defineProps<{
  // The project name to render in the trigger button. Usually status?.project
  // (live from /health) -- falls back to "(unknown)" while the first poll is
  // in flight.
  currentName: string | null;
  // Whether the manual override is active (drives the "(manual)" badge).
  hasManualOverride: boolean;
}>();

const sdk = useSDK();
const supervisor = useSupervisor();
const projects = useJxscoutProjects();
const manualProject = useManualProject();

const open = ref(false);
const search = ref("");
const newName = ref("");
const isApplying = ref(false);
const searchInputRef = ref<InstanceType<typeof InputText> | null>(null);

const filtered = computed(() => {
  const list = projects.projects.value ?? [];
  const q = search.value.trim().toLowerCase();
  if (q.length === 0) return list;
  return list.filter((p) => p.name.toLowerCase().includes(q));
});

// "Use new project name" is only meaningful when the typed value isn't blank
// and doesn't exactly match an entry in the list (where the user could just
// click the entry instead).
const newNameTrimmed = computed(() => newName.value.trim());
const canApplyNew = computed(() => {
  if (newNameTrimmed.value.length === 0) return false;
  const list = projects.projects.value ?? [];
  return !list.some((p) => p.name === newNameTrimmed.value);
});

const onOpen = async () => {
  open.value = true;
  search.value = "";
  newName.value = "";
  // Lazy fetch on open with the 5s cache built into the composable. The user
  // is unlikely to re-open the picker within that window; if they do we save
  // a round-trip.
  void projects.fetchIfStale();
  // Focus the search input so the user can type immediately. nextTick waits
  // for v-if to mount the DOM; $el is PrimeVue's wrapped <input>.
  await nextTick();
  const el = (searchInputRef.value as unknown as { $el?: HTMLInputElement })
    ?.$el;
  if (el && typeof el.focus === "function") el.focus();
};

const onClose = () => {
  open.value = false;
};

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    e.preventDefault();
    onClose();
  }
};

// The actual apply path: persist the override, then restart the supervisor
// so it rebinds. Reuses the auto-sync 'switching' event under the hood --
// restartJxscoutHandler doesn't fire that event itself, so we don't bother
// trying to wire up a transient pill here; the supervisor's running -> stopped
// -> starting -> running cycle is short enough (~420ms) that the user sees
// the picker close, the ManagedRunning card briefly drop, and the new project
// in place.
const applyName = async (name: string) => {
  if (isApplying.value) return;
  isApplying.value = true;
  try {
    const ok = await manualProject.set(name);
    if (!ok) return;
    onClose();
    const restartResp = await supervisor.restart();
    if (!restartResp.success) {
      sdk.window.showToast(
        `Failed to restart jxscout: ${restartResp.error}`,
        { variant: "error" }
      );
    }
  } finally {
    isApplying.value = false;
  }
};

const onPickExisting = (name: string) => {
  void applyName(name);
};

const onApplyNew = () => {
  const name = newNameTrimmed.value;
  if (!canApplyNew.value) return;
  void applyName(name);
};

// "Clear override" -- only visible when hasManualOverride is true. Falls
// back to following Caido's current project on the next Start/Restart (per
// resolveStartArgs).
const onClearOverride = async () => {
  if (isApplying.value) return;
  isApplying.value = true;
  try {
    const ok = await manualProject.set(null);
    if (!ok) return;
    onClose();
    const restartResp = await supervisor.restart();
    if (!restartResp.success) {
      sdk.window.showToast(
        `Failed to restart jxscout: ${restartResp.error}`,
        { variant: "error" }
      );
    }
  } finally {
    isApplying.value = false;
  }
};

// Reset transient state when the picker closes externally (Esc / click-out).
watch(open, (next) => {
  if (!next) {
    search.value = "";
    newName.value = "";
  }
});
</script>

<template>
  <span class="inline-flex min-w-0 items-center gap-1.5">
    <!-- Inline trigger: looks like a clickable text label, matches the visual
         weight of the other meta-row values. text-style PrimeVue Button keeps
         it from feeling like a heavy CTA. Truncates if the project name is
         absurdly long. -->
    <button
      type="button"
      class="min-w-0 truncate rounded-sm px-1 py-0.5 text-left text-sm text-surface-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 dark:text-surface-200"
      :disabled="isApplying"
      @click="onOpen"
    >
      {{ currentName ?? "—" }}
    </button>
    <span
      v-if="hasManualOverride"
      class="inline-flex items-center rounded bg-surface-700 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-surface-300 dark:bg-surface-700 dark:text-surface-300"
      title="Bound to a manually picked project, not Caido's current project"
    >
      manual
    </span>

    <Teleport to="body">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        role="presentation"
        @click.self="onClose"
        @keydown="onKeydown"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="project-picker-title"
          class="flex w-full max-w-sm flex-col gap-3 rounded-md border border-surface-600 bg-surface-800 p-4 shadow-xl"
        >
          <div class="flex items-center justify-between gap-2">
            <h4
              id="project-picker-title"
              class="m-0 text-base font-semibold text-surface-800 dark:text-white/90"
            >
              Pick a project
            </h4>
            <Button
              severity="secondary"
              text
              size="small"
              icon="pi pi-refresh"
              :loading="projects.isLoading.value"
              aria-label="Refresh project list"
              @click="projects.refresh()"
            />
          </div>

          <InputText
            ref="searchInputRef"
            v-model="search"
            placeholder="Search projects..."
            class="box-border"
            fluid
            size="small"
          />

          <!-- Scrollable list. Caps height so the picker doesn't dominate
               smaller viewports; the existing per-row truncation keeps long
               names from overflowing. -->
          <div class="max-h-64 min-h-[8rem] overflow-y-auto rounded border border-surface-700 bg-surface-900/50">
            <template v-if="projects.projects.value === null">
              <div class="px-3 py-4 text-center text-sm text-surface-500 dark:text-surface-400">
                <template v-if="projects.isLoading.value">
                  Loading...
                </template>
                <template v-else>
                  (jxscout not responding)
                </template>
              </div>
            </template>
            <template v-else-if="filtered.length === 0">
              <div class="px-3 py-4 text-center text-sm text-surface-500 dark:text-surface-400">
                <template v-if="(projects.projects.value ?? []).length === 0">
                  No projects yet
                </template>
                <template v-else>
                  No matches
                </template>
              </div>
            </template>
            <template v-else>
              <button
                v-for="p in filtered"
                :key="p.name"
                type="button"
                class="flex w-full min-w-0 flex-col items-start gap-0.5 border-b border-surface-700 px-3 py-2 text-left last:border-b-0 hover:bg-surface-700/60 focus:bg-surface-700/60 focus:outline-none disabled:opacity-50"
                :disabled="isApplying"
                @click="onPickExisting(p.name)"
              >
                <span class="flex w-full min-w-0 items-center gap-2">
                  <span class="truncate text-sm font-medium text-surface-700 dark:text-surface-200">
                    {{ p.name }}
                  </span>
                  <span
                    v-if="currentName === p.name"
                    class="inline-flex items-center rounded bg-success-500/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success-300"
                  >
                    current
                  </span>
                </span>
                <code class="block min-w-0 truncate font-mono text-[11px] text-surface-500 dark:text-surface-400 [overflow-wrap:anywhere]">
                  {{ p.path }}
                </code>
              </button>
            </template>
          </div>

          <div class="flex flex-col gap-2 border-t border-surface-700 pt-3">
            <span class="text-xs text-surface-500 dark:text-surface-400">
              Or use a new project name (created on first ingest):
            </span>
            <div class="flex gap-2">
              <InputText
                v-model="newName"
                placeholder="my-new-project"
                class="box-border flex-1 font-mono"
                fluid
                size="small"
                @keydown.enter="onApplyNew"
              />
              <Button
                label="Apply"
                size="small"
                :disabled="!canApplyNew || isApplying"
                :loading="isApplying"
                @click="onApplyNew"
              />
            </div>
          </div>

          <div class="flex items-center justify-between gap-2 border-t border-surface-700 pt-3">
            <Button
              v-if="hasManualOverride"
              severity="secondary"
              text
              size="small"
              label="Clear override"
              :disabled="isApplying"
              @click="onClearOverride"
            />
            <span v-else />
            <Button
              severity="secondary"
              text
              size="small"
              label="Cancel"
              @click="onClose"
            />
          </div>
        </div>
      </div>
    </Teleport>
  </span>
</template>
