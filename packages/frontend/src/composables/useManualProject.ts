import { type InjectionKey, type Ref, inject, provide, ref } from "vue";

import { useSDK } from "@/plugins/sdk";

// Phase 10 manual project picker state. Lives in this composable rather than
// useSettings because it's per-Caido-instance: the backend keeps it in
// module-scope memory only, so we can't piggy-back on settings.json round
// trips. The picker calls set() to update both sides; the rest of the UI
// reads `manualProjectName` to render the "(manual)" badge.
export type ManualProjectState = {
  manualProjectName: Ref<string | null>;
  isLoading: Ref<boolean>;
  // Push a new override to the backend. Returns true on success. Callers
  // typically follow this with supervisor.restart() to make the override
  // take effect immediately.
  set: (name: string | null) => Promise<boolean>;
  // Pull the backend's current value into our ref. Called once on mount;
  // available as a manual refresh if the UI ever needs one.
  load: () => Promise<void>;
};

const KEY: InjectionKey<ManualProjectState> = Symbol("ManualProjectState");

const createManualProjectState = (): ManualProjectState => {
  const sdk = useSDK();

  const manualProjectName = ref<string | null>(null);
  const isLoading = ref(false);

  const load = async (): Promise<void> => {
    isLoading.value = true;
    try {
      const response = await sdk.backend.getManualProject();
      if (response.success) {
        manualProjectName.value = response.data.manualProjectName;
      } else {
        // Toast would be noisy for an init-time pull -- log only.
        // eslint-disable-next-line no-console
        console.error(`Failed to load manual project: ${response.error}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Failed to load manual project: ${err}`);
    } finally {
      isLoading.value = false;
    }
  };

  const set = async (name: string | null): Promise<boolean> => {
    isLoading.value = true;
    try {
      const response = await sdk.backend.setManualProject(name);
      if (!response.success) {
        sdk.window.showToast(
          `Failed to save manual project: ${response.error}`,
          { variant: "error" }
        );
        return false;
      }
      manualProjectName.value = response.data.manualProjectName;
      return true;
    } catch (err) {
      sdk.window.showToast(`Failed to save manual project: ${err}`, {
        variant: "error",
      });
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  return { manualProjectName, isLoading, set, load };
};

export const provideManualProject = (): ManualProjectState => {
  const state = createManualProjectState();
  provide(KEY, state);
  // Fire-and-forget initial load. Backend's module-scope state defaults to
  // null on plugin init so this almost always resolves immediately to null;
  // worth doing anyway so a survivor of an HMR refresh sees the truth.
  void state.load();
  return state;
};

export const useManualProject = (): ManualProjectState => {
  const state = inject(KEY);
  if (!state) {
    throw new Error(
      "useManualProject() called without a provideManualProject() ancestor"
    );
  }
  return state;
};
