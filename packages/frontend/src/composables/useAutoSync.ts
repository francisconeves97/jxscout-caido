import {
  type InjectionKey,
  type Ref,
  inject,
  onScopeDispose,
  provide,
  ref,
  watch,
} from "vue";

import { useSDK } from "@/plugins/sdk";

// Phase 8: transient "Switching project..." indicator. The backend emits an
// `auto-sync` event whenever `onProjectChange` triggers a side effect; the
// frontend turns that into a temporary status pill on the Managed cards.
//
// Backend payload shape -- kept loose here so the consumer doesn't have to
// import the backend type; the `kind` discriminator is the only field UIs
// actually branch on.
type AutoSyncEvent =
  | { kind: "switching"; from: string | null; to: string }
  | { kind: "stopping"; from: string | null };

// Pill lifetime. Long enough to read; short enough that it doesn't linger past
// the supervisor's typical stopped -> starting -> running cycle (~500-1000ms
// in practice). Independent of supervisor state changes -- the pill is purely
// a transient affordance for "yes, we noticed the project change".
const PILL_LIFETIME_MS = 1500;

export type AutoSyncState = {
  event: Ref<AutoSyncEvent | null>;
};

const KEY: InjectionKey<AutoSyncState> = Symbol("AutoSyncState");

// Mirrors useSupervisor's enable-gating: only subscribe when the user is in
// managed mode and Pro. Free / Manual users never see an auto-sync event.
const createAutoSyncState = (enabled: Ref<boolean>): AutoSyncState => {
  const sdk = useSDK();

  const event = ref<AutoSyncEvent | null>(null);
  let unsubscribe: { stop: () => void } | null = null;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearAfter = (ms: number) => {
    if (clearTimer !== null) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      if (disposed) return;
      event.value = null;
      clearTimer = null;
    }, ms);
  };

  const subscribe = () => {
    if (unsubscribe) return;
    unsubscribe = sdk.backend.onEvent("auto-sync", (next: AutoSyncEvent) => {
      if (disposed) return;
      event.value = next;
      clearAfter(PILL_LIFETIME_MS);
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
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    event.value = null;
  };

  watch(
    enabled,
    (on) => {
      if (on) subscribe();
      else teardown();
    },
    { immediate: true }
  );

  onScopeDispose(() => {
    disposed = true;
    teardown();
  });

  return { event };
};

export const provideAutoSync = (enabled: Ref<boolean>): AutoSyncState => {
  const state = createAutoSyncState(enabled);
  provide(KEY, state);
  return state;
};

export const useAutoSync = (): AutoSyncState => {
  const state = inject(KEY);
  if (!state) {
    throw new Error("useAutoSync() called without a provideAutoSync() ancestor");
  }
  return state;
};
