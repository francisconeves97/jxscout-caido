import {
  type InjectionKey,
  type Ref,
  inject,
  onScopeDispose,
  provide,
  ref,
  watch,
} from "vue";
import type { JxscoutStatus, Settings } from "backend";

import { useSDK } from "@/plugins/sdk";

const POLL_INTERVAL_MS = 3000;

export type JxscoutStatusState = {
  status: Ref<JxscoutStatus | null>;
  lastChecked: Ref<number | null>;
  isFetching: Ref<boolean>;
  reconnect: () => Promise<void>;
};

const KEY: InjectionKey<JxscoutStatusState> = Symbol("JxscoutStatusState");

// Takes settings + enabled explicitly because provide() and inject() can't be
// called against the same component instance; App.vue passes them in.
//
// `enabled` gates the polling loop -- the composable does nothing while it's
// false. App.vue sets it to true once both the license is confirmed Pro and
// the saved settings have loaded, so we never poll with default-but-not-yet-
// loaded host/port and never burn cycles for free users.
//
// `portOverride` carries Managed mode's actual session port (snapshot.port).
// Managed mode auto-allocates and binds 127.0.0.1 so we ignore settings.host
// in that case too; null override means "no live supervisor" and we fall
// back to the manual-mode host/port the user typed in.
const createJxscoutStatusState = (
  settings: Ref<Settings>,
  enabled: Ref<boolean>,
  portOverride: Ref<number | null>
): JxscoutStatusState => {
  const sdk = useSDK();

  const status = ref<JxscoutStatus | null>(null);
  const lastChecked = ref<number | null>(null);
  const isFetching = ref(false);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const effectivePort = (): number => {
    const override = portOverride.value;
    return typeof override === "number" && override > 0
      ? override
      : settings.value.port;
  };

  const effectiveHost = (): string => {
    // Managed mode (portOverride present) -> supervisor always binds
    // 127.0.0.1, regardless of what's in settings.host (which is the
    // manual-mode connection target). Avoids "localhost" / IPv6 / hostname
    // resolution surprises across parallel Caido instances.
    const override = portOverride.value;
    if (typeof override === "number" && override > 0) return "127.0.0.1";
    return settings.value.host;
  };

  const fetchOnce = async () => {
    if (isFetching.value) return;
    isFetching.value = true;
    try {
      const next = await sdk.backend.fetchJxscoutStatus(
        effectiveHost(),
        effectivePort()
      );
      status.value = next;
      lastChecked.value = Date.now();
    } finally {
      isFetching.value = false;
    }
  };

  const scheduleNext = () => {
    if (stopped || !enabled.value) return;
    timer = setTimeout(async () => {
      await fetchOnce();
      scheduleNext();
    }, POLL_INTERVAL_MS);
  };

  const startLoop = async () => {
    if (stopped || !enabled.value) return;
    clearTimer();
    await fetchOnce();
    scheduleNext();
  };

  const reconnect = async () => {
    if (!enabled.value) return;
    await startLoop();
  };

  // Start/stop polling whenever the gate flips, then restart on host/port save.
  watch(
    enabled,
    (on) => {
      if (on) {
        void startLoop();
      } else {
        clearTimer();
        status.value = null;
      }
    },
    { immediate: true }
  );

  watch(
    () => `${effectiveHost()}:${effectivePort()}`,
    () => {
      if (enabled.value) void startLoop();
    }
  );

  onScopeDispose(() => {
    stopped = true;
    clearTimer();
  });

  return { status, lastChecked, isFetching, reconnect };
};

export const provideJxscoutStatus = (
  settings: Ref<Settings>,
  enabled: Ref<boolean>,
  portOverride: Ref<number | null>
): JxscoutStatusState => {
  const state = createJxscoutStatusState(settings, enabled, portOverride);
  provide(KEY, state);
  return state;
};

export const useJxscoutStatus = (): JxscoutStatusState => {
  const state = inject(KEY);
  if (!state) {
    throw new Error(
      "useJxscoutStatus() called without a provideJxscoutStatus() ancestor"
    );
  }
  return state;
};
