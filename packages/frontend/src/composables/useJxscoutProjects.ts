import {
  type InjectionKey,
  type Ref,
  inject,
  provide,
  ref,
} from "vue";
import type { ProjectEntry } from "backend";

import { useSDK } from "@/plugins/sdk";

// Phase 10: lazy-fetch known jxscout projects when the picker opens. No
// continuous polling -- the user only sees this list while they have the
// picker open, so a fresh fetch each open is cheap and avoids stale state
// after a free-form Apply creates a new project on the jxscout side. We
// cache for 5s purely so multiple consumers opening the picker back-to-back
// don't double-fetch.

const STALE_AFTER_MS = 5000;

export type JxscoutProjectsState = {
  projects: Ref<ProjectEntry[] | null>;
  isLoading: Ref<boolean>;
  error: Ref<string | null>;
  refresh: () => Promise<void>;
  // Returns cached data immediately if still fresh, otherwise triggers a
  // refresh. Callers (e.g. the picker's popover @show handler) use this so
  // a re-open within 5s doesn't double-fetch.
  fetchIfStale: () => Promise<void>;
};

const KEY: InjectionKey<JxscoutProjectsState> = Symbol("JxscoutProjectsState");

const createJxscoutProjectsState = (): JxscoutProjectsState => {
  const sdk = useSDK();

  // null distinguishes "never fetched" / "supervisor not running" from
  // "fetched, empty list". The picker renders these cases differently --
  // "(jxscout not responding)" vs "no projects yet".
  const projects = ref<ProjectEntry[] | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  let lastFetchedAt = 0;

  const refresh = async () => {
    isLoading.value = true;
    error.value = null;
    try {
      const result = await sdk.backend.listJxscoutProjects();
      projects.value = result;
      lastFetchedAt = Date.now();
    } catch (err) {
      error.value = `${err}`;
      projects.value = null;
    } finally {
      isLoading.value = false;
    }
  };

  const fetchIfStale = async () => {
    if (Date.now() - lastFetchedAt < STALE_AFTER_MS && projects.value !== null) {
      return;
    }
    await refresh();
  };

  return { projects, isLoading, error, refresh, fetchIfStale };
};

export const provideJxscoutProjects = (): JxscoutProjectsState => {
  const state = createJxscoutProjectsState();
  provide(KEY, state);
  return state;
};

export const useJxscoutProjects = (): JxscoutProjectsState => {
  const state = inject(KEY);
  if (!state) {
    throw new Error(
      "useJxscoutProjects() called without a provideJxscoutProjects() ancestor"
    );
  }
  return state;
};
