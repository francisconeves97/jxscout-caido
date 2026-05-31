import {
  type InjectionKey,
  type Ref,
  inject,
  onScopeDispose,
  provide,
  ref,
} from "vue";

import { useSDK } from "@/plugins/sdk";

export type LicenseState = {
  isPro: Ref<boolean>;
  isLoading: Ref<boolean>;
  isLoaded: Ref<boolean>;
  refresh: () => Promise<void>;
};

const KEY: InjectionKey<LicenseState> = Symbol("LicenseState");

const createLicenseState = (): LicenseState => {
  const sdk = useSDK();

  const isPro = ref(false);
  const isLoading = ref(false);
  const isLoaded = ref(false);

  const refresh = async () => {
    isLoading.value = true;
    try {
      const response = await sdk.backend.hasLicense();
      if (response.success) {
        isPro.value = response.data;
        isLoaded.value = true;
      } else {
        sdk.window.showToast(`Failed to check license: ${response.error}`, {
          variant: "error",
        });
      }
    } catch (err) {
      sdk.window.showToast(`Failed to check license: ${err}`, {
        variant: "error",
      });
    } finally {
      isLoading.value = false;
    }
  };

  // Phase 9: re-check the license file when the Caido tab regains focus.
  // Catches the user deleting ~/.jxscout-pro/.license externally, or
  // jxscout-pro-v2 clearing it on a Keygen heartbeat failure. App.vue
  // watches isPro for a true -> false transition and handles the toast +
  // supervisor stop side effects -- this composable just owns the source
  // of truth.
  //
  // Plain 'focus' is correct here: it fires when the user navigates back
  // to the Caido tab from elsewhere, which is the only realistic vector
  // for an external license change to be relevant to UI state. Polling
  // on a timer would burn cycles for a rare event.
  const onFocus = () => {
    void refresh();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocus);
    onScopeDispose(() => {
      window.removeEventListener("focus", onFocus);
    });
  }

  return { isPro, isLoading, isLoaded, refresh };
};

export const provideLicense = (): LicenseState => {
  const state = createLicenseState();
  provide(KEY, state);
  return state;
};

export const useLicense = (): LicenseState => {
  const state = inject(KEY);
  if (!state) {
    throw new Error("useLicense() called without a provideLicense() ancestor");
  }
  return state;
};
