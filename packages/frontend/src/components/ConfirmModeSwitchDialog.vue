<script setup lang="ts">
import Button from "primevue/button";
import { nextTick, ref, watch } from "vue";

defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (e: "choice", value: "stop" | "keep" | "cancel"): void;
}>();

const stopButtonRef = ref<InstanceType<typeof Button> | null>(null);

// Plan: default focus on Stop. Wait a tick after the v-if mount so the
// button's DOM element exists, then call $el.focus(). PrimeVue's <Button>
// wraps a real <button> at $el.
watch(
  () => stopButtonRef.value,
  async (btn) => {
    if (!btn) return;
    await nextTick();
    const el = (btn as unknown as { $el?: HTMLElement }).$el;
    if (el && typeof el.focus === "function") el.focus();
  }
);

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("choice", "cancel");
  }
};
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    role="presentation"
    @click.self="emit('choice', 'cancel')"
    @keydown="onKeydown"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-mode-switch-title"
      class="w-full max-w-sm rounded-md border border-surface-600 bg-surface-800 p-4 shadow-xl"
    >
      <h4
        id="confirm-mode-switch-title"
        class="m-0 mb-2 text-base font-semibold text-surface-800 dark:text-white/90"
      >
        Stop the managed jxscout?
      </h4>
      <p class="m-0 mb-4 text-sm text-surface-500 dark:text-surface-400">
        Switching to Manual mode while jxscout is running. Stop it now, or
        leave it running and connect to it like a regular Manual jxscout?
      </p>
      <div class="flex justify-end gap-2">
        <Button
          severity="secondary"
          text
          size="small"
          label="Cancel"
          @click="emit('choice', 'cancel')"
        />
        <Button
          severity="secondary"
          size="small"
          label="Keep running"
          @click="emit('choice', 'keep')"
        />
        <Button
          ref="stopButtonRef"
          severity="danger"
          size="small"
          label="Stop"
          @click="emit('choice', 'stop')"
        />
      </div>
    </div>
  </div>
</template>
