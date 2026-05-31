<script setup lang="ts">
import type { Mode } from "backend";

defineProps<{
  mode: Mode;
  isPro: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "select", mode: Mode): void;
}>();

const select = (next: Mode) => {
  emit("select", next);
};
</script>

<template>
  <div class="grid grid-cols-2 gap-2">
    <button
      type="button"
      :disabled="disabled"
      class="relative flex flex-col items-start text-left rounded-md border bg-surface-800 p-3 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      :class="
        mode === 'manual'
          ? 'border-success-500/70 ring-1 ring-success-500/30'
          : 'border-surface-600 hover:bg-surface-700'
      "
      @click="select('manual')"
    >
      <h5
        class="m-0 mb-1 text-sm font-semibold flex items-center gap-2 text-surface-800 dark:text-white/80"
      >
        <span
          v-if="mode === 'manual'"
          class="inline-block w-2 h-2 rounded-full bg-success-500"
          aria-hidden="true"
        ></span>
        Manual
      </h5>
      <p
        class="m-0 text-sm text-surface-500 dark:text-surface-400 leading-snug"
      >
        Run jxscout yourself, point the plugin at its host/port.
      </p>
    </button>

    <button
      type="button"
      :disabled="disabled"
      class="relative flex flex-col items-start text-left rounded-md border bg-surface-800 p-3 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      :class="[
        mode === 'managed'
          ? 'border-secondary-500/70 ring-1 ring-secondary-500/30'
          : 'border-surface-600 hover:bg-surface-700',
      ]"
      @click="select('managed')"
    >
      <span
        v-if="!isPro"
        class="absolute top-2 right-2 text-xs font-semibold tracking-wide px-1.5 py-0.5 rounded bg-secondary-500/20 text-secondary-300"
      >
        PRO
      </span>
      <h5
        class="m-0 mb-1 text-sm font-semibold flex items-center gap-2 text-surface-800 dark:text-white/80"
      >
        <span
          v-if="mode === 'managed'"
          class="inline-block w-2 h-2 rounded-full bg-secondary-500"
          aria-hidden="true"
        ></span>
        Managed
      </h5>
      <p
        class="m-0 text-sm text-surface-500 dark:text-surface-400 leading-snug pr-10"
      >
        Plugin launches jxscout — stop/restart from this panel. Auto-syncs with
        Caido projects.
      </p>
    </button>
  </div>
</template>
