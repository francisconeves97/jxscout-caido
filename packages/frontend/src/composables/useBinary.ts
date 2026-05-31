import {
  type InjectionKey,
  type Ref,
  computed,
  inject,
  onScopeDispose,
  provide,
  ref,
  watch,
} from "vue";
import type { DetectionResult, ReleaseType } from "backend";

import { useSDK } from "@/plugins/sdk";

export type BinaryState = {
  detection: Ref<DetectionResult | null>;
  isLoading: Ref<boolean>;
  isLoaded: Ref<boolean>;
  hasBinary: Ref<boolean>;
  releaseType: Ref<ReleaseType | null>;
  releaseTypeLoaded: Ref<boolean>;
  refresh: () => Promise<void>;
};

const KEY: InjectionKey<BinaryState> = Symbol("BinaryState");

// `enabled` follows the Phase 4/6 convention: don't fire detection until the
// user is confirmed Pro and in managed mode. Free / Manual users never even
// shell out to `which`. Refreshing on detection re-runs the full discovery
// pipeline (custom -> PATH -> managed).
const createBinaryState = (enabled: Ref<boolean>): BinaryState => {
  const sdk = useSDK();

  const detection = ref<DetectionResult | null>(null);
  const isLoading = ref(false);
  const isLoaded = ref(false);
  const releaseType = ref<ReleaseType | null>(null);
  const releaseTypeLoaded = ref(false);

  const hasBinary = computed(() =>
    detection.value !== null && detection.value.source !== null
  );

  const refresh = async () => {
    isLoading.value = true;
    try {
      const result = await sdk.backend.detectBinary();
      detection.value = result;
      isLoaded.value = true;
    } catch (err) {
      sdk.window.showToast(`Failed to detect binary: ${err}`, {
        variant: "error",
      });
    } finally {
      isLoading.value = false;
    }
  };

  // releaseType is host-platform-only; doesn't change at runtime. Fetch
  // once on first enable, cache. Used by BIN-1 to show the right platform
  // label and to surface the "unsupported platform" hard-fail.
  const loadReleaseType = async () => {
    if (releaseTypeLoaded.value) return;
    try {
      const r = await sdk.backend.getReleaseType();
      releaseType.value = r;
      releaseTypeLoaded.value = true;
    } catch (err) {
      // Frontend SDK has no `console`; the error is rare (only fires if the
      // RPC layer itself blows up) and not actionable for the user.
      console.error(`Failed to load release type: ${err}`);
    }
  };

  watch(
    enabled,
    (on) => {
      if (on) {
        void refresh();
        void loadReleaseType();
      }
    },
    { immediate: true }
  );

  // Re-run detection when the Caido tab regains focus. The discovery pipeline
  // (custom path -> PATH -> managed) reflects the live filesystem + $PATH, so
  // a user who removed the binary from PATH while Caido was backgrounded sees
  // the stale entry replaced as soon as they refocus. Mirrors useLicense's
  // focus refresh -- same trade-off: rare event, cheap RPC, no polling.
  const onFocus = () => {
    if (!enabled.value) return;
    void refresh();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocus);
    onScopeDispose(() => {
      window.removeEventListener("focus", onFocus);
    });
  }

  return {
    detection,
    isLoading,
    isLoaded,
    hasBinary,
    releaseType,
    releaseTypeLoaded,
    refresh,
  };
};

export const provideBinary = (enabled: Ref<boolean>): BinaryState => {
  const state = createBinaryState(enabled);
  provide(KEY, state);
  return state;
};

export const useBinary = (): BinaryState => {
  const state = inject(KEY);
  if (!state) {
    throw new Error("useBinary() called without a provideBinary() ancestor");
  }
  return state;
};
