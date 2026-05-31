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
import type {
  StartResult,
  StopResult,
  SupervisorSnapshot,
} from "backend";

import { useSDK } from "@/plugins/sdk";

// How often to update the derived "uptime" display while running. 500ms
// matches StatusCard.vue's last-ping ticker; same trade-off (visible
// granularity without burning render cycles).
const UPTIME_TICK_MS = 500;

export type SupervisorState = {
  snapshot: Ref<SupervisorSnapshot | null>;
  isLoaded: Ref<boolean>;
  uptimeMs: Ref<number | null>;
  isBusy: Ref<boolean>;
  start: () => Promise<StartResult>;
  stop: () => Promise<StopResult>;
  restart: () => Promise<StartResult>;
  refresh: () => Promise<void>;
};

const KEY: InjectionKey<SupervisorState> = Symbol("SupervisorState");

// `enabled` gates both the initial state fetch and the live event
// subscription. App.vue sets it true once the user is confirmed Pro AND in
// managed mode -- mirroring the Phase 4 pattern for useJxscoutStatus. Free
// users + Manual users never even attach the listener.
const createSupervisorState = (enabled: Ref<boolean>): SupervisorState => {
  const sdk = useSDK();

  const snapshot = ref<SupervisorSnapshot | null>(null);
  const isLoaded = ref(false);
  const isBusy = ref(false);
  const now = ref(Date.now());

  let unsubscribe: { stop: () => void } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const uptimeMs = computed<number | null>(() => {
    const snap = snapshot.value;
    if (!snap || snap.state !== "running" || snap.startedAt === null) {
      return null;
    }
    return Math.max(0, now.value - snap.startedAt);
  });

  const refresh = async () => {
    try {
      const s = await sdk.backend.getSupervisorState();
      if (disposed) return;
      snapshot.value = s;
      isLoaded.value = true;
    } catch (err) {
      sdk.window.showToast(`Supervisor: failed to read state: ${err}`, {
        variant: "error",
      });
    }
  };

  const subscribe = () => {
    if (unsubscribe) return;
    unsubscribe = sdk.backend.onEvent("supervisor-state", (next) => {
      if (disposed) return;
      snapshot.value = next;
      isLoaded.value = true;
    });
  };

  const teardown = () => {
    if (unsubscribe) {
      try {
        unsubscribe.stop();
      } catch {
        // swallow
      }
      unsubscribe = null;
    }
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const start = async (): Promise<StartResult> => {
    isBusy.value = true;
    try {
      return await sdk.backend.startJxscout();
    } finally {
      isBusy.value = false;
    }
  };

  const stop = async (): Promise<StopResult> => {
    isBusy.value = true;
    try {
      return await sdk.backend.stopJxscout();
    } finally {
      isBusy.value = false;
    }
  };

  const restart = async (): Promise<StartResult> => {
    isBusy.value = true;
    try {
      return await sdk.backend.restartJxscout();
    } finally {
      isBusy.value = false;
    }
  };

  watch(
    enabled,
    (on) => {
      if (on) {
        void refresh();
        subscribe();
        if (timer === null) {
          timer = setInterval(() => {
            now.value = Date.now();
          }, UPTIME_TICK_MS);
        }
      } else {
        teardown();
      }
    },
    { immediate: true }
  );

  onScopeDispose(() => {
    disposed = true;
    teardown();
  });

  return { snapshot, isLoaded, uptimeMs, isBusy, start, stop, restart, refresh };
};

export const provideSupervisor = (enabled: Ref<boolean>): SupervisorState => {
  const state = createSupervisorState(enabled);
  provide(KEY, state);
  return state;
};

export const useSupervisor = (): SupervisorState => {
  const state = inject(KEY);
  if (!state) {
    throw new Error(
      "useSupervisor() called without a provideSupervisor() ancestor"
    );
  }
  return state;
};
