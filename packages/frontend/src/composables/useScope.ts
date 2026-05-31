import { type InjectionKey, type Ref, inject, provide, ref, watch } from "vue";

import type { SupervisorState } from "@/composables/useSupervisor";
import { useSDK } from "@/plugins/sdk";

export type FetchedScope = {
  in_scope: string[];
  out_of_scope: string[];
};

export type ScopeState = {
  // Latest scope read from jxscout's GET /scope, refreshed on every
  // supervisor->running transition. `null` before the first successful fetch
  // (or while the supervisor is offline) -- ScopeSettings.vue uses that to
  // decide whether to seed its textareas.
  fetchedScope: Ref<FetchedScope | null>;
  // True while a fetch is in flight. Lets ScopeSettings disable its inputs
  // so the user doesn't type into a textarea that's about to be overwritten.
  isFetching: Ref<boolean>;
  // Push explicit patterns. Used by ScopeSettings.vue's Save button so typed
  // values land in jxscout immediately.
  pushPatterns: (in_scope: string[], out_of_scope: string[]) => Promise<boolean>;
  // Manual refresh hook. Currently unused by consumers but kept so the UI can
  // expose a "reload" affordance if we ever want one without re-plumbing.
  refresh: () => Promise<void>;
};

const KEY: InjectionKey<ScopeState> = Symbol("ScopeState");

const createScopeState = (supervisor: SupervisorState): ScopeState => {
  const sdk = useSDK();

  const fetchedScope = ref<FetchedScope | null>(null);
  const isFetching = ref(false);

  const refresh = async (): Promise<void> => {
    isFetching.value = true;
    try {
      const response = await sdk.backend.fetchScope();
      if (!response.success) {
        sdk.window.showToast(`Scope fetch failed: ${response.error}`, {
          variant: "error",
        });
        return;
      }
      fetchedScope.value = {
        in_scope: [...response.data.in_scope],
        out_of_scope: [...response.data.out_of_scope],
      };
    } catch (err) {
      sdk.window.showToast(`Scope fetch failed: ${err}`, { variant: "error" });
    } finally {
      isFetching.value = false;
    }
  };

  const pushPatterns = async (
    in_scope: string[],
    out_of_scope: string[]
  ): Promise<boolean> => {
    try {
      const response = await sdk.backend.pushScope({
        in_scope,
        out_of_scope,
      });
      if (!response.success) {
        sdk.window.showToast(`Scope push failed: ${response.error}`, {
          variant: "error",
        });
        return false;
      }
      // Optimistically reflect what we just pushed so a subsequent project
      // change starts from the right baseline without an extra round trip.
      fetchedScope.value = { in_scope: [...in_scope], out_of_scope: [...out_of_scope] };
      return true;
    } catch (err) {
      sdk.window.showToast(`Scope push failed: ${err}`, { variant: "error" });
      return false;
    }
  };

  // Re-read the *current project's* scope whenever the supervisor transitions
  // into "running". Covers first Start, auto-launch at plugin init, Restart
  // (project switch / explicit button), and download/specify-path success.
  // Replaces an older "push the cached patterns" hook that used to clobber a
  // freshly-switched project's scope with whichever patterns the user last
  // saved -- the plugin no longer owns the source of truth.
  watch(
    () => supervisor.snapshot.value?.state,
    (next, prev) => {
      if (next === "running" && prev !== "running") {
        void refresh();
      } else if (next !== "running" && prev === "running") {
        // Clear when the supervisor goes away so the textareas don't keep
        // displaying stale patterns from a no-longer-running project.
        fetchedScope.value = null;
      }
    }
  );

  // First mount: if the supervisor is already running (auto-launch finished
  // before this composable mounted), seed immediately.
  if (supervisor.snapshot.value?.state === "running") {
    void refresh();
  }

  return { fetchedScope, isFetching, pushPatterns, refresh };
};

export const provideScope = (supervisor: SupervisorState): ScopeState => {
  const state = createScopeState(supervisor);
  provide(KEY, state);
  return state;
};

export const useScope = (): ScopeState => {
  const state = inject(KEY);
  if (!state) {
    throw new Error("useScope() called without a provideScope() ancestor");
  }
  return state;
};
