import { type InjectionKey, type Ref, inject, provide, ref } from "vue";
import type { Settings } from "backend";

import { useSDK } from "@/plugins/sdk";

const DEFAULT_SETTINGS: Settings = {
  host: "localhost",
  port: 3333,
  filterInScope: false,
  mode: "manual",
  customBinaryPath: null,
  defaultProjectsDir: null,
  autoLaunch: true,
  autoSync: true,
};

export type SettingsState = {
  settings: Ref<Settings>;
  isLoading: Ref<boolean>;
  isLoaded: Ref<boolean>;
  load: () => Promise<void>;
  save: (overrides?: Partial<Settings>) => Promise<boolean>;
};

const KEY: InjectionKey<SettingsState> = Symbol("SettingsState");

const createSettingsState = (): SettingsState => {
  const sdk = useSDK();

  const settings = ref<Settings>({ ...DEFAULT_SETTINGS });
  const isLoading = ref(false);
  const isLoaded = ref(false);

  const load = async () => {
    isLoading.value = true;
    try {
      const response = await sdk.backend.getSettings();
      if (response.success) {
        settings.value = response.data;
        isLoaded.value = true;
      } else {
        sdk.window.showToast(`Failed to load settings: ${response.error}`, {
          variant: "error",
        });
      }
    } catch (err) {
      sdk.window.showToast(`Failed to load settings: ${err}`, {
        variant: "error",
      });
    } finally {
      isLoading.value = false;
    }
  };

  const save = async (overrides: Partial<Settings> = {}): Promise<boolean> => {
    isLoading.value = true;
    try {
      const payload: Settings = { ...settings.value, ...overrides };
      const response = await sdk.backend.saveSettings(payload);
      if (response.success) {
        settings.value = response.data;
        return true;
      }
      sdk.window.showToast(`Failed to save settings: ${response.error}`, {
        variant: "error",
      });
      return false;
    } catch (err) {
      sdk.window.showToast(`Failed to save settings: ${err}`, {
        variant: "error",
      });
      return false;
    } finally {
      isLoading.value = false;
    }
  };

  return { settings, isLoading, isLoaded, load, save };
};

export const provideSettings = (): SettingsState => {
  const state = createSettingsState();
  provide(KEY, state);
  return state;
};

export const useSettings = (): SettingsState => {
  const state = inject(KEY);
  if (!state) {
    throw new Error(
      "useSettings() called without a provideSettings() ancestor"
    );
  }
  return state;
};
