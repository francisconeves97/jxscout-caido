<script setup lang="ts">
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { DownloadProgress } from "backend";

import { useBinary } from "@/composables/useBinary";
import { useSettings } from "@/composables/useSettings";
import { useSupervisor } from "@/composables/useSupervisor";
import { useSDK } from "@/plugins/sdk";

const props = defineProps<{
  // Allows reopening BIN-3 inline from <ManagedSettings />. Default is BIN-1
  // (the plan's confirmed UX: sub-state is component-local; remount resets
  // to BIN-1).
  initialView?: "choice" | "specify";
}>();

const emit = defineEmits<{
  (e: "back"): void;
}>();

type View = "choice" | "downloading" | "specify";

const view = ref<View>(props.initialView === "specify" ? "specify" : "choice");

const sdk = useSDK();
const binary = useBinary();
const settingsState = useSettings();
const supervisor = useSupervisor();

// After a successful download or path save, kick off the supervisor when
// auto-launch is on. Mirrors plugin-init auto-launch but for the "user just
// finished setup" moment — without it the user is dumped on a Stopped card
// and has to click Start, which is friction when they already opted into
// auto-launch.
const maybeAutoStart = async () => {
  if (!settingsState.settings.value.autoLaunch) return;
  const result = await supervisor.start();
  if (!result.success) {
    sdk.window.showToast(`Failed to auto-start: ${result.error}`, {
      variant: "error",
    });
  }
};

// BIN-3 state ---------------------------------------------------------------
// Absolute path typed/pasted by the user. A native file picker would be
// nicer, but Electron 32+ stripped File.path and Caido's plugin SDK doesn't
// expose webUtils.getPathForFile — so renderer-side picking can't recover
// an absolute path. The backend validates the string via `--version`.
const specifyPath = ref("");
const isValidating = ref(false);
const validationError = ref<string | null>(null);

const canValidate = computed(
  () => specifyPath.value.trim().length > 0 && !isValidating.value
);

const onSpecify = () => {
  view.value = "specify";
};

const onValidateAndSave = async () => {
  if (!canValidate.value) return;
  isValidating.value = true;
  validationError.value = null;
  try {
    const trimmed = specifyPath.value.trim();
    const validation = await sdk.backend.validateBinary(trimmed);
    if (!validation.valid) {
      validationError.value = validation.error ?? "Validation failed";
      return;
    }
    const saved = await sdk.backend.setCustomBinaryPath(trimmed);
    if (!saved.success) {
      validationError.value = saved.error;
      return;
    }
    sdk.window.showToast(`Binary set to ${trimmed}`, { variant: "success" });
    specifyPath.value = "";
    await Promise.all([settingsState.load(), binary.refresh()]);
    await maybeAutoStart();
  } catch (err) {
    validationError.value = String(err);
  } finally {
    isValidating.value = false;
  }
};

// BIN-2 state ---------------------------------------------------------------
const progress = ref<DownloadProgress | null>(null);
const isDownloading = ref(false);
let unsubscribe: { stop: () => void } | null = null;

// Attach the progress listener as soon as the card mounts. It's cheap and
// keeps timing simple: events emitted during the resolver-resolve hop
// don't race the subscribe call.
onMounted(() => {
  unsubscribe = sdk.backend.onEvent("download-progress", (next) => {
    progress.value = next;
  });
});

onUnmounted(() => {
  if (unsubscribe) {
    try {
      unsubscribe.stop();
    } catch {
      // swallow
    }
  }
});

const onDownload = async () => {
  view.value = "downloading";
  isDownloading.value = true;
  progress.value = { kind: "resolving" };
  try {
    const result = await sdk.backend.downloadBinary();
    if (result.success) {
      sdk.window.showToast(`Binary installed at ${result.path}`, {
        variant: "success",
      });
      await binary.refresh();
      // No need to flip the view back; <ManagedView /> will route past
      // <BinarySetup /> once detection reflects the install.
      await maybeAutoStart();
    } else {
      // Stay on the downloading view so the user can read the error from
      // the rendered progress card; offer a "Try again / Specify path"
      // affordance.
      sdk.window.showToast(`Download failed: ${result.error}`, {
        variant: "error",
      });
    }
  } catch (err) {
    sdk.window.showToast(`Download failed: ${err}`, { variant: "error" });
  } finally {
    isDownloading.value = false;
  }
};

const onRetryDownload = () => {
  progress.value = null;
  void onDownload();
};

const platformLabel = computed(() => {
  const rt = binary.releaseType.value;
  if (!binary.releaseTypeLoaded.value) return "detecting platform…";
  if (rt === null) return "Unsupported platform";
  // Pretty labels matching the marketing site.
  switch (rt) {
    case "linux-386":
      return "Linux (x86 32-bit)";
    case "linux-amd64":
      return "Linux (x86_64)";
    case "linux-arm64":
      return "Linux (ARM64)";
    case "macos-amd64":
      return "macOS (Intel)";
    case "macos-arm64":
      return "macOS (Apple Silicon)";
    case "windows-amd64":
      return "Windows (x86_64)";
    case "windows-arm64":
      return "Windows (ARM64)";
  }
});

const isMacOS = computed(() => {
  const rt = binary.releaseType.value;
  return rt === "macos-amd64" || rt === "macos-arm64";
});

const isLinux = computed(() => {
  const rt = binary.releaseType.value;
  return (
    rt === "linux-386" || rt === "linux-amd64" || rt === "linux-arm64"
  );
});

const isWindows = computed(() => {
  const rt = binary.releaseType.value;
  return rt === "windows-amd64" || rt === "windows-arm64";
});

const progressLabel = computed(() => {
  const p = progress.value;
  if (!p) return "";
  switch (p.kind) {
    case "resolving":
      return "Resolving download URL…";
    case "downloading":
      if (p.total === null || p.total === 0) {
        return `Downloading… (${formatBytes(p.bytes)})`;
      }
      return `Downloading… (${formatBytes(p.bytes)} of ${formatBytes(p.total)})`;
    case "extracting":
      return "Extracting archive…";
    case "installing":
      return "Installing binary…";
    case "done":
      return `Installed v${p.version}`;
    case "error":
      return `Failed: ${p.error}`;
  }
});

const progressFraction = computed(() => {
  const p = progress.value;
  if (!p) return 0;
  if (p.kind === "resolving") return 0.05;
  if (p.kind === "downloading") {
    if (p.total === null || p.total === 0) return 0.5;
    return Math.min(0.85, 0.1 + (p.bytes / p.total) * 0.75);
  }
  if (p.kind === "extracting") return 0.9;
  if (p.kind === "installing") return 0.95;
  if (p.kind === "done") return 1;
  return 0;
});

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const onBack = () => {
  if (props.initialView) {
    emit("back");
    return;
  }
  view.value = "choice";
};
</script>

<template>
  <!-- BIN-1: choice -->
  <div
    v-if="view === 'choice'"
    class="flex flex-col gap-3 rounded-md border border-surface-600 bg-surface-800 p-4"
  >
    <div>
      <h3
        class="m-0 text-sm font-semibold text-surface-800 dark:text-white/80"
      >
        Set up jxscout-pro-v2
      </h3>
      <p
        class="m-0 mt-1 text-sm text-surface-500 dark:text-surface-400 leading-snug"
      >
        Caido couldn't find the <code class="font-mono">jxscout-pro-v2</code>
        binary on this machine. Either download it from
        <a
          href="https://jxscout.app/"
          target="_blank"
          rel="noopener noreferrer"
          class="text-info-400 hover:underline"
          >jxscout.app</a
        >
        or point to an existing copy.
      </p>
    </div>

    <button
      type="button"
      :disabled="binary.releaseType.value === null"
      class="flex flex-col items-start gap-1 rounded-md border border-surface-600 bg-surface-700 p-3 text-left transition hover:border-secondary-500/40 hover:ring-1 hover:ring-secondary-500/30 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-surface-600 disabled:hover:ring-0"
      @click="onDownload"
    >
      <div class="flex w-full items-center justify-between gap-2">
        <span
          class="text-sm font-semibold text-surface-800 dark:text-white/80"
          >Download for {{ platformLabel }}</span
        >
        <span
          class="rounded-full bg-secondary-500/15 px-2 py-0.5 text-xs font-medium text-secondary-300"
          >Recommended</span
        >
      </div>
      <span
        class="text-sm text-surface-500 dark:text-surface-400 leading-snug"
      >
        Fetches the latest release from jxscout.app using your license key,
        installs it at <code class="font-mono">~/.jxscout-pro/bin/</code>, and
        starts it.
      </span>
      <span
        v-if="binary.releaseType.value === null"
        class="text-xs text-red-400"
      >
        This platform doesn't have a prebuilt release. Pick "Specify path"
        and select a self-built binary.
      </span>
    </button>

    <button
      type="button"
      class="flex flex-col items-start gap-1 rounded-md border border-surface-600 bg-surface-700 p-3 text-left transition hover:border-surface-500"
      @click="onSpecify"
    >
      <span class="text-sm font-semibold text-surface-800 dark:text-white/80"
        >Specify path</span
      >
      <span
        class="text-sm text-surface-500 dark:text-surface-400 leading-snug"
      >
        Already have <code class="font-mono">jxscout-pro-v2</code> installed?
        Select the binary file.
      </span>
    </button>

    <div class="flex items-center justify-between pt-1">
      <Button
        label="Back to Manual"
        severity="secondary"
        text
        @click="settingsState.save({ mode: 'manual' })"
      />
    </div>
  </div>

  <!-- BIN-2: download progress -->
  <div
    v-else-if="view === 'downloading'"
    class="flex flex-col gap-3 rounded-md border border-surface-600 bg-surface-800 p-4"
    :class="{
      'ring-1 ring-success-500/30': progress?.kind === 'done',
      'ring-1 ring-red-500/30': progress?.kind === 'error',
    }"
  >
    <div>
      <h3
        class="m-0 text-sm font-semibold text-surface-800 dark:text-white/80"
      >
        Installing jxscout-pro-v2
      </h3>
      <p
        class="m-0 mt-1 text-sm text-surface-500 dark:text-surface-400 leading-snug"
      >
        {{ progressLabel }}
      </p>
    </div>

    <div
      v-if="progress?.kind !== 'error'"
      class="h-2 w-full overflow-hidden rounded-full bg-surface-700"
      aria-hidden="true"
    >
      <div
        class="h-full bg-secondary-500 transition-all"
        :style="{ width: `${progressFraction * 100}%` }"
      ></div>
    </div>

    <p
      v-if="progress?.kind === 'error'"
      class="m-0 break-words rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    >
      {{ progress.error }}
    </p>

    <!-- Post-install OS guidance: macOS Gatekeeper + Linux execute bit -->
    <p
      v-if="progress?.kind === 'done' && isMacOS"
      class="m-0 text-sm text-surface-500 dark:text-surface-400 leading-snug"
    >
      <strong class="text-surface-700 dark:text-surface-200">macOS:</strong>
      The binary isn't notarized. If Gatekeeper blocks the first launch, open
      <strong>System Settings &gt; Privacy &amp; Security</strong> and click
      <em>Allow Anyway</em> next to the jxscout-pro-v2 entry, then retry
      Start.
    </p>
    <p
      v-if="progress?.kind === 'done' && isWindows"
      class="m-0 text-sm text-surface-500 dark:text-surface-400 leading-snug"
    >
      <strong class="text-surface-700 dark:text-surface-200">Windows:</strong>
      The binary isn't signed. If SmartScreen blocks it, click
      <em>More info &rarr; Run anyway</em>.
    </p>
    <p
      v-if="progress?.kind === 'done' && isLinux"
      class="m-0 text-sm text-surface-500 dark:text-surface-400 leading-snug"
    >
      Installed at <code class="font-mono">~/.jxscout-pro/bin/jxscout-pro-v2</code>.
    </p>

    <div class="flex items-center justify-between pt-1">
      <Button
        v-if="!isDownloading"
        label="Back"
        severity="secondary"
        text
        @click="onBack"
      />
      <span v-else></span>

      <Button
        v-if="progress?.kind === 'error'"
        label="Try again"
        severity="warn"
        @click="onRetryDownload"
      />
    </div>
  </div>

  <!-- BIN-3: specify path -->
  <div
    v-else
    class="flex flex-col gap-3 rounded-md border border-surface-600 bg-surface-800 p-4"
  >
    <div>
      <h3
        class="m-0 text-sm font-semibold text-surface-800 dark:text-white/80"
      >
        Select binary
      </h3>
      <p
        class="m-0 mt-1 text-sm text-surface-500 dark:text-surface-400 leading-snug"
      >
        Paste the absolute path to <code class="font-mono">jxscout-pro-v2</code>.
        Tip: drag the binary onto a terminal window to reveal its path, or run
        <code class="font-mono">which jxscout-pro-v2</code>. The path is
        validated with <code class="font-mono">--version</code> before saving.
      </p>
    </div>

    <div class="flex flex-col gap-2">
      <InputText
        v-model="specifyPath"
        placeholder="/path/to/jxscout-pro-v2"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        class="font-mono text-xs"
        :disabled="isValidating"
        fluid
        @keydown.enter="onValidateAndSave"
      />
      <Button
        :label="isValidating ? 'Validating…' : 'Validate & Save'"
        :disabled="!canValidate"
        :loading="isValidating"
        @click="onValidateAndSave"
      />
    </div>

    <p
      v-if="validationError"
      class="m-0 break-words rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    >
      {{ validationError }}
    </p>

    <div class="flex items-center justify-between pt-1">
      <Button
        :label="props.initialView ? 'Cancel' : 'Back'"
        severity="secondary"
        text
        :disabled="isValidating"
        @click="onBack"
      />
    </div>
  </div>
</template>
