import type { SDK } from "caido:plugin";
import { RequestSpec } from "caido:utils";
import { Blob, fetch } from "caido:http";
import type { DefinePluginPackageSpec } from "@caido/sdk-shared";
import { spawn } from "child_process";
import { readFile, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  DetectionResult,
  ValidationResult,
  detectBinary,
  validateBinary,
} from "./binary";
import {
  DownloadProgress,
  DownloadResult,
  ReleaseType,
  downloadBinary as downloadBinaryFn,
  releaseTypeForCurrentPlatform,
} from "./download";
import {
  clearLicense as clearLicenseFile,
  hasLicense as hasLicenseFile,
  readLicense,
  writeLicense,
} from "./license";
import {
  StartResult,
  StopResult,
  SupervisorSnapshot,
  findFreePort,
  getSupervisorState,
  recoverOrphan,
  restartJxscout as restartJxscoutFn,
  startJxscout as startJxscoutFn,
  stopJxscout as stopJxscoutFn,
} from "./supervisor";
import {
  JxscoutStatus,
  ProjectEntry,
  Response,
  Settings,
  StoredLicense,
} from "./types";

export type {
  JxscoutStatus,
  Mode,
  ProjectEntry,
  Response,
  Settings,
  StoredLicense,
} from "./types";
export type { BinarySource, DetectionResult, ValidationResult } from "./binary";
export type {
  DownloadProgress,
  DownloadResult,
  ReleaseType,
} from "./download";
export type {
  StartResult,
  StopResult,
  SupervisorSnapshot,
  SupervisorStateName,
} from "./supervisor";

const STATUS_FETCH_TIMEOUT_MS = 1000;
// /scope responds quickly (just an ArcSwap store + tracing log), but keep some
// headroom for cold-start cases. Matches PROJECTS_FETCH_TIMEOUT_MS.
const SCOPE_PUSH_TIMEOUT_MS = 1500;

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

let globalSettings: Settings | null = null;

function ok<T>(data: T): Response<T> {
  return {
    success: true,
    data,
  };
}

function error(message: string): Response<never> {
  return {
    success: false,
    error: message,
  };
}

const getSettingsFilePath = (sdk: SDK) => {
  return path.join(sdk.meta.path(), "settings.json");
};

// Additive migration: keep every known field that parses; fill the rest with
// defaults. Tolerates the legacy {host,port,filterInScope} shape and any
// future garbage by clamping to declared types instead of crashing. Unknown
// fields (e.g. legacy lastIntendedState/manualProjectName/manualInScope)
// are silently dropped on load.
const migrateSettings = (raw: unknown): Settings => {
  const parsed: Record<string, unknown> =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const stringOrNull = (v: unknown, fallback: string | null): string | null => {
    if (typeof v === "string") return v;
    if (v === null) return null;
    return fallback;
  };

  const mode =
    parsed.mode === "managed" || parsed.mode === "manual"
      ? parsed.mode
      : DEFAULT_SETTINGS.mode;

  return {
    host:
      typeof parsed.host === "string" ? parsed.host : DEFAULT_SETTINGS.host,
    port:
      typeof parsed.port === "number" && Number.isFinite(parsed.port)
        ? parsed.port
        : DEFAULT_SETTINGS.port,
    filterInScope:
      typeof parsed.filterInScope === "boolean"
        ? parsed.filterInScope
        : DEFAULT_SETTINGS.filterInScope,
    mode,
    customBinaryPath: stringOrNull(
      parsed.customBinaryPath,
      DEFAULT_SETTINGS.customBinaryPath
    ),
    defaultProjectsDir: stringOrNull(
      parsed.defaultProjectsDir,
      DEFAULT_SETTINGS.defaultProjectsDir
    ),
    autoLaunch:
      typeof parsed.autoLaunch === "boolean"
        ? parsed.autoLaunch
        : DEFAULT_SETTINGS.autoLaunch,
    autoSync:
      typeof parsed.autoSync === "boolean"
        ? parsed.autoSync
        : DEFAULT_SETTINGS.autoSync,
  };
};

const saveSettings = async (
  sdk: SDK,
  incoming: Partial<Settings>
): Promise<Response<Settings>> => {
  const settingsFilePath = getSettingsFilePath(sdk);

  try {
    // Normalise via migrateSettings so the on-disk file always lands in the
    // canonical shape, even when an older frontend sends a partial payload.
    const normalised = migrateSettings(incoming);
    await writeFile(settingsFilePath, JSON.stringify(normalised, null, 2));
    sdk.console.log(`Settings saved to ${settingsFilePath}`);

    globalSettings = normalised;

    return ok(normalised);
  } catch (err) {
    sdk.console.error(`Failed to save settings: ${err}`);

    return error(`Failed to save settings: ${err}`);
  }
};

const getSettings = async (sdk: SDK): Promise<Response<Settings>> => {
  const settingsFilePath = getSettingsFilePath(sdk);

  sdk.console.log(`Loading settings from ${settingsFilePath}`);

  try {
    const raw = await readFile(settingsFilePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      sdk.console.error(
        `Failed to parse settings, using defaults: ${parseErr}`
      );
      return ok({ ...DEFAULT_SETTINGS });
    }
    return ok(migrateSettings(parsed));
  } catch (err) {
    sdk.console.error(`Failed to read settings: ${err}`);
    return ok({ ...DEFAULT_SETTINGS });
  }
};

const getLicenseHandler = async (
  sdk: SDK
): Promise<Response<StoredLicense | null>> => {
  try {
    return ok(await readLicense());
  } catch (err) {
    sdk.console.error(`Failed to read license: ${err}`);
    return error(`Failed to read license: ${err}`);
  }
};

const setLicenseHandler = async (
  sdk: SDK,
  key: string
): Promise<Response<StoredLicense>> => {
  try {
    await writeLicense(key);
    const stored = await readLicense();
    if (!stored) {
      return error("License written but could not be read back");
    }
    return ok(stored);
  } catch (err) {
    sdk.console.error(`Failed to write license: ${err}`);
    return error(`Failed to write license: ${err}`);
  }
};

const clearLicenseHandler = async (
  sdk: SDK
): Promise<Response<null>> => {
  try {
    await clearLicenseFile();
    return ok(null);
  } catch (err) {
    sdk.console.error(`Failed to clear license: ${err}`);
    return error(`Failed to clear license: ${err}`);
  }
};

const hasLicenseHandler = async (
  sdk: SDK
): Promise<Response<boolean>> => {
  try {
    return ok(await hasLicenseFile());
  } catch (err) {
    sdk.console.error(`Failed to check license: ${err}`);
    return error(`Failed to check license: ${err}`);
  }
};

// Any failure -- timeout, refused, non-2xx, malformed JSON -- collapses to null
// so the frontend has a single "disconnected" signal to render against.
//
// Uses an explicit AbortController + setTimeout rather than AbortSignal.timeout()
// because the latter triggered a segfault inside the LLRT runtime when fetch
// failed with ECONNREFUSED (caido-cli crashed mid-call during Phase 4 dev).
const fetchJxscoutStatus = async (
  sdk: SDK,
  host: string,
  port: number
): Promise<JxscoutStatus | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // swallow
    }
  }, STATUS_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const raw = (await response.json()) as unknown;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const obj = raw as Record<string, unknown>;
    if (
      typeof obj.status !== "string" ||
      typeof obj.project !== "string" ||
      typeof obj.working_directory !== "string" ||
      typeof obj.version !== "string"
    ) {
      return null;
    }
    return {
      status: obj.status,
      project: obj.project,
      working_directory: obj.working_directory,
      version: obj.version,
    };
  } catch (err) {
    sdk.console.log(`fetchJxscoutStatus: ${err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// Phase 5: binary discovery RPCs. detectBinary/validateBinary mirror
// fetchJxscoutStatus -- they collapse failures into their own result types
// rather than the Response<T> wrapper, so the frontend has a single shape to
// render. The settings-mutating RPCs use Response<Settings> to match
// saveSettings.
const readCurrentSettings = async (sdk: SDK): Promise<Settings> => {
  const response = await getSettings(sdk);
  if (response.success) return response.data;
  // getSettings already collapses every failure to defaults, but type-narrow
  // for completeness so the RPC can't accidentally swallow a real error path.
  return { ...DEFAULT_SETTINGS };
};

const detectBinaryHandler = async (sdk: SDK): Promise<DetectionResult> => {
  const settings = await readCurrentSettings(sdk);
  return await detectBinary(settings.customBinaryPath);
};

const validateBinaryHandler = async (
  _sdk: SDK,
  binaryPath: string
): Promise<ValidationResult> => {
  return await validateBinary(binaryPath);
};

const setCustomBinaryPathHandler = async (
  sdk: SDK,
  binaryPath: string
): Promise<Response<Settings>> => {
  if (typeof binaryPath !== "string" || binaryPath.trim().length === 0) {
    return error("Custom binary path cannot be empty");
  }
  const current = await readCurrentSettings(sdk);
  return await saveSettings(sdk, {
    ...current,
    customBinaryPath: binaryPath.trim(),
  });
};

const clearCustomBinaryPathHandler = async (
  sdk: SDK
): Promise<Response<Settings>> => {
  const current = await readCurrentSettings(sdk);
  return await saveSettings(sdk, { ...current, customBinaryPath: null });
};

// Lowercase a-z0-9 + hyphen so the value passes muster as a project name on
// the jxscout side (which writes it into a project directory). Shared between
// the start-args resolver and Phase 8's auto-sync handler so both code paths
// agree on the canonical form.
const normalizeProjectName = (raw: string): string => {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "caido";
};

// Phase 6 supervisor handlers. Mutator RPCs (start/stop/restart) use the
// supervisor's own result types -- they're typed-result, not Response<T>,
// because the supervisor needs to surface the pid/port from a successful
// start (not just "ok"). Query-style RPCs (getSupervisorState) collapse
// failures to a snapshot, matching the Phase 5 contract for detectBinary.
const resolveStartArgs = async (
  sdk: SDK
): Promise<
  { ok: true; binaryPath: string; project: string; port: number; defaultProjectsDir: string | null }
  | { ok: false; error: string }
> => {
  const settings = await readCurrentSettings(sdk);

  const detection = await detectBinary(settings.customBinaryPath);
  if (detection.source === null) {
    return {
      ok: false,
      error:
        "jxscout-pro-v2 binary not found (custom path / PATH / managed install all empty)",
    };
  }

  // Phase 10 manual project override. Only honored when autoSync is off --
  // when on, the Phase 8 onProjectChange handler is the authority and we
  // always follow Caido's current project. We normalize here so a free-form
  // name typed in the picker (e.g. "My Project") canonicalises to the same
  // slug the supervisor would have used. The override lives in module-scope
  // state (not settings.json) so parallel Caido processes sharing the same
  // Data dir can each pick their own manual project independently.
  let finalProject: string;
  if (settings.autoSync === false && typeof inMemoryManualProjectName === "string") {
    const overrideRaw = inMemoryManualProjectName.trim();
    if (overrideRaw.length > 0) {
      finalProject = normalizeProjectName(overrideRaw);
    } else {
      finalProject = "";
    }
  } else {
    finalProject = "";
  }

  if (finalProject.length === 0) {
    const projectFromCaido = await sdk.projects.getCurrent();
    const projectName =
      projectFromCaido && typeof projectFromCaido.getName() === "string"
        ? projectFromCaido.getName().trim()
        : "";
    if (projectName.length === 0) {
      return {
        ok: false,
        error: "No active Caido project; open one before starting Managed mode",
      };
    }
    finalProject = normalizeProjectName(projectName);
  }

  // Port allocation. The managed port is STICKY for this Caido process's
  // lifetime -- once chosen we reuse it for every start / restart / project
  // switch. We deliberately ignore settings.port (the manual-mode connection
  // target, not a managed-mode preference).
  //
  // Why sticky: resolveStartArgs runs BEFORE restartJxscout stops the old
  // process, so a fresh findFreePort(3333) probe on every call would skip
  // past our own still-bound port and creep upward on each restart (and
  // project switch, which restarts too). The user connects to a port that
  // keeps changing out from under them -- bad UX.
  //
  // Reuse rules:
  //   - supervisor live (running/starting): reuse its port verbatim. It's
  //     ours, and the stop that precedes the restart frees it before we
  //     rebind.
  //   - otherwise (fresh start / after stop): probe from the remembered port
  //     so we land on it again if it's free, only walking past it if a
  //     foreign process grabbed it while we were down.
  // Parallel Caido instances each keep their own cache (module scope), so the
  // first probe still spreads them across distinct ports.
  const MANAGED_BASE_PORT = 3333;
  const snap = getSupervisorState();
  let port: number | null;
  if (
    (snap.state === "running" || snap.state === "starting") &&
    typeof snap.port === "number" &&
    Number.isFinite(snap.port) &&
    snap.port > 0
  ) {
    port = snap.port;
  } else {
    const preferred = managedPort ?? MANAGED_BASE_PORT;
    port = await findFreePort(preferred);
    if (port === null) {
      return {
        ok: false,
        error: `No free port in [${preferred}, ${preferred + 49}]`,
      };
    }
    if (port !== preferred) {
      sdk.console.log(
        `supervisor: preferred port ${preferred} busy, using ${port} this session`
      );
    }
  }
  managedPort = port;

  return {
    ok: true,
    binaryPath: detection.path,
    project: finalProject,
    port,
    defaultProjectsDir: settings.defaultProjectsDir,
  };
};

// Module-scope per-Caido-process state. Intentionally not persisted to
// settings.json (which is shared across parallel Caido instances sharing
// the same Data dir). The Phase 10 manual project override lives here so
// each Caido can pick its own without trampling siblings.
let inMemoryManualProjectName: string | null = null;

// Sticky managed port for this Caido process. Set on first start, then reused
// across every restart / project switch so the port the user connects to
// doesn't creep upward (see the port-allocation note in resolveStartArgs).
// Per-process (module scope) so parallel Caido instances keep distinct ports.
let managedPort: number | null = null;

const startJxscoutHandler = async (sdk: SDK): Promise<StartResult> => {
  const args = await resolveStartArgs(sdk);
  if (!args.ok) return { success: false, error: args.error };
  return await startJxscoutFn(sdk, {
    binaryPath: args.binaryPath,
    project: args.project,
    port: args.port,
    defaultProjectsDir: args.defaultProjectsDir,
  });
};

const stopJxscoutHandler = async (sdk: SDK): Promise<StopResult> => {
  return await stopJxscoutFn(sdk);
};

const restartJxscoutHandler = async (sdk: SDK): Promise<StartResult> => {
  const args = await resolveStartArgs(sdk);
  if (!args.ok) return { success: false, error: args.error };
  return await restartJxscoutFn(sdk, {
    binaryPath: args.binaryPath,
    project: args.project,
    port: args.port,
    defaultProjectsDir: args.defaultProjectsDir,
  });
};

const getSupervisorStateHandler = async (
  _sdk: SDK
): Promise<SupervisorSnapshot> => {
  return getSupervisorState();
};

// Phase 7 download flow. Resolves the v2 endpoint, fetches the archive, and
// installs the binary at ~/.jxscout-pro/bin/jxscout-pro-v2[.exe]. Progress
// arrives on the frontend via the "download-progress" event. Mutator-style
// result type per the Phase 5/6 convention (collapses failures into the
// typed result rather than Response<T>).
const downloadBinaryHandler = async (sdk: SDK): Promise<DownloadResult> => {
  return await downloadBinaryFn(sdk);
};

// Lets the frontend show the right platform label on the BIN-1 card and the
// "Unsupported platform" hard-fail case before the user clicks Download.
const getReleaseTypeHandler = async (
  _sdk: SDK
): Promise<ReleaseType | null> => {
  return releaseTypeForCurrentPlatform();
};

// ---------------------------------------------------------------------------
// Phase 10: manual project picker (auto-sync off)
// ---------------------------------------------------------------------------

const PROJECTS_FETCH_TIMEOUT_MS = 1500;

// Effective port mirrors useJxscoutStatus on the frontend: prefer the live
// session port if the supervisor is up, otherwise the persisted preference.
// Same fallback shape as fetchJxscoutStatus's callsite.
const effectivePort = (settings: Settings): number => {
  const snap = getSupervisorState();
  if (
    snap.state === "running" &&
    typeof snap.port === "number" &&
    Number.isFinite(snap.port) &&
    snap.port > 0
  ) {
    return snap.port;
  }
  return Number.isFinite(settings.port) && settings.port > 0
    ? settings.port
    : 3333;
};

// Returns null when the supervisor isn't running OR jxscout-rs doesn't answer.
// The frontend uses null as a single "(jxscout not responding)" signal -- same
// convention as fetchJxscoutStatus.
//
// AbortController + setTimeout (not AbortSignal.timeout()) per the Phase 4
// LLRT gotcha: the latter crashed caido-cli when fetch failed with
// ECONNREFUSED.
const listJxscoutProjectsHandler = async (
  sdk: SDK
): Promise<ProjectEntry[] | null> => {
  const settings = await readCurrentSettings(sdk);
  const snap = getSupervisorState();

  // If the supervisor's not running, hitting settings.port could either fail
  // (no jxscout) or hit some OTHER process on that port. Either way we don't
  // have a trustworthy answer to render in the picker.
  if (snap.state !== "running") {
    return null;
  }

  const port = effectivePort(settings);
  const host =
    typeof settings.host === "string" && settings.host.trim().length > 0
      ? settings.host
      : "localhost";

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // swallow
    }
  }, PROJECTS_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`http://${host}:${port}/projects`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const raw = (await response.json()) as unknown;
    if (!Array.isArray(raw)) {
      return null;
    }
    const out: ProjectEntry[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.name !== "string" || typeof obj.path !== "string") continue;
      out.push({ name: obj.name, path: obj.path });
    }
    return out;
  } catch (err) {
    sdk.console.log(`listJxscoutProjects: ${err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Scope push: relay host patterns to jxscout's POST /scope endpoint. Called
// by the frontend's Save button only. Scope is per-project on the jxscout
// side, so the plugin no longer caches patterns in its own settings or
// re-pushes them on supervisor start -- doing so used to clobber a new
// project's scope with the previous project's patterns on every project
// switch. The frontend now fetches scope via GET /scope after each supervisor
// start to populate the UI.
//
// AbortController + manual setTimeout (not AbortSignal.timeout()) per the
// Phase 4 LLRT gotcha that crashed caido-cli on ECONNREFUSED.
const pushScopeHandler = async (
  sdk: SDK,
  payload: { in_scope: string[]; out_of_scope: string[] }
): Promise<Response<null>> => {
  const settings = await readCurrentSettings(sdk);
  const snap = getSupervisorState();
  // Don't try to push when there's no supervisor to receive the call. The
  // frontend re-pushes on the next supervisor-start anyway, so dropping the
  // call here just avoids a spurious ECONNREFUSED toast.
  if (snap.state !== "running") {
    return ok(null);
  }

  const port = effectivePort(settings);
  const host =
    typeof settings.host === "string" && settings.host.trim().length > 0
      ? settings.host
      : "localhost";

  // Defensive: trim + drop empties on the way out. jxscout-rs's set_scope
  // handler does the same normalization, but doing it here too keeps the
  // wire payload tidy (e.g. easier to diff in logs).
  const normalize = (xs: unknown): string[] =>
    Array.isArray(xs)
      ? xs
          .filter((v): v is string => typeof v === "string")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
  const body = {
    in_scope: normalize(payload?.in_scope),
    out_of_scope: normalize(payload?.out_of_scope),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // swallow
    }
  }, SCOPE_PUSH_TIMEOUT_MS);

  try {
    // Caido's quickjs runtime types `body` as `Blob` (see
    // @caido/quickjs-types/src/caido/http.d.ts:151), not `string` like the DOM
    // fetch -- wrap the JSON in a Blob so the typecheck passes and the
    // content-type is honored.
    const response = await fetch(`http://${host}:${port}/scope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Blob([JSON.stringify(body)], { type: "application/json" }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return error(
        `jxscout /scope returned ${response.status}${
          detail ? `: ${detail.slice(0, 200)}` : ""
        }`
      );
    }
    sdk.console.log(
      `pushScope: in_scope=${body.in_scope.length} out_of_scope=${body.out_of_scope.length}`
    );
    return ok(null);
  } catch (err) {
    sdk.console.error(`pushScope failed: ${err}`);
    return error(`pushScope failed: ${err}`);
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Scope fetch: read the live scope from jxscout's GET /scope so the frontend
// can populate its textareas with whichever patterns the *current* project
// has on disk. Called on every supervisor->running transition (incl. project
// switch). Same AbortController pattern as pushScopeHandler.
const fetchScopeHandler = async (
  sdk: SDK
): Promise<Response<{ in_scope: string[]; out_of_scope: string[] }>> => {
  const settings = await readCurrentSettings(sdk);
  const snap = getSupervisorState();
  // No supervisor -> nothing to read. Return empty arrays rather than an
  // error so the frontend can just clear its textareas.
  if (snap.state !== "running") {
    return ok({ in_scope: [], out_of_scope: [] });
  }

  const port = effectivePort(settings);
  const host =
    typeof settings.host === "string" && settings.host.trim().length > 0
      ? settings.host
      : "localhost";

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // swallow
    }
  }, SCOPE_PUSH_TIMEOUT_MS);

  try {
    const response = await fetch(`http://${host}:${port}/scope`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return error(
        `jxscout GET /scope returned ${response.status}${
          detail ? `: ${detail.slice(0, 200)}` : ""
        }`
      );
    }
    const raw = (await response.json()) as unknown;
    const normalize = (xs: unknown): string[] =>
      Array.isArray(xs)
        ? xs
            .filter((v): v is string => typeof v === "string")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];
    const obj =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const data = {
      in_scope: normalize(obj.in_scope),
      out_of_scope: normalize(obj.out_of_scope),
    };
    sdk.console.log(
      `fetchScope: in_scope=${data.in_scope.length} out_of_scope=${data.out_of_scope.length}`
    );
    return ok(data);
  } catch (err) {
    sdk.console.error(`fetchScope failed: ${err}`);
    return error(`fetchScope failed: ${err}`);
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Open a filesystem path in an external tool (file manager / VS Code / Cursor).
//
// `tool` decides the launcher; the path is passed as the last arg verbatim so
// we don't need shell quoting. Tools other than "folder" rely on the user
// having `code` / `cursor` on PATH (both editors expose a CLI helper from
// their command palette). When the binary is missing the spawn 'error' event
// fires asynchronously -- we attach a listener so the error makes it to the
// plugin log instead of crashing the runtime.
//
// LLRT's SpawnOptions omits `detached` and ChildProcess has no `.unref()`,
// so we can't formally detach. In practice the platform launchers (`open`,
// `xdg-open`, `explorer`) and the editor CLI helpers exit milliseconds after
// the target window opens, so the spawned process doesn't outlive the RPC.
// ---------------------------------------------------------------------------

type OpenTool = "folder" | "vscode" | "cursor";

const resolveOpenCommand = (
  tool: OpenTool
): { cmd: string; args: readonly string[] } | null => {
  switch (tool) {
    case "folder": {
      const platform = os.platform();
      if (platform === "darwin") return { cmd: "open", args: [] };
      if (platform === "win32") return { cmd: "explorer", args: [] };
      // Linux + BSDs: xdg-open is the freedesktop standard; ships with
      // virtually every desktop distro.
      return { cmd: "xdg-open", args: [] };
    }
    case "vscode":
      return { cmd: "code", args: [] };
    case "cursor":
      return { cmd: "cursor", args: [] };
  }
};

const openPathHandler = async (
  sdk: SDK,
  payload: { path: string; tool: OpenTool }
): Promise<Response<null>> => {
  if (
    typeof payload?.path !== "string" ||
    payload.path.trim().length === 0
  ) {
    return error("Empty path");
  }
  const resolved = resolveOpenCommand(payload.tool);
  if (!resolved) {
    return error(`Unsupported tool: ${payload.tool}`);
  }

  try {
    const child = spawn(resolved.cmd, [...resolved.args, payload.path], {
      stdio: "ignore",
    });
    child.on("error", (err: Error) => {
      sdk.console.error(
        `openPath(${payload.tool}) spawn error: ${err.message ?? String(err)}`
      );
    });
    return ok(null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sdk.console.error(`openPath(${payload.tool}) failed: ${message}`);
    return error(`Failed to launch ${payload.tool}: ${message}`);
  }
};

// Stores the manual override in module-scope memory; the frontend explicitly
// calls restartJxscout afterwards when it wants the supervisor to rebind.
// Splitting save and restart keeps the RPC composable -- a future "save the
// override but don't restart" flow (e.g. setting it before first Start) Just
// Works. The value is intentionally not persisted: it's per-Caido-instance
// state (and parallel Caido processes might each want a different project).
const setManualProjectHandler = async (
  _sdk: SDK,
  name: string | null
): Promise<Response<{ manualProjectName: string | null }>> => {
  const next: string | null =
    typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
  inMemoryManualProjectName = next;
  return ok({ manualProjectName: next });
};

const getManualProjectHandler = async (
  _sdk: SDK
): Promise<Response<{ manualProjectName: string | null }>> => {
  return ok({ manualProjectName: inMemoryManualProjectName });
};

// ---------------------------------------------------------------------------
// Phase 8: auto-launch + auto-sync
// ---------------------------------------------------------------------------

// Fired at the top of an auto-sync restart so the frontend can show a
// "Switching project..." pill while the supervisor cycles through stopped ->
// starting -> running. Also fired on the "project closed" path so the UI
// can show a brief "Stopping..." indicator. Frontend hides the pill on the
// next supervisor 'running' (or 'stopped') transition or after a ~1.5s
// timeout, whichever fires first.
export type AutoSyncEvent =
  | { kind: "switching"; from: string | null; to: string }
  | { kind: "stopping"; from: string | null };

// sdk.api.send types against Spec.events. We use the same narrow cast as the
// supervisor / download modules to avoid threading a generic everywhere. The
// frontend's onEvent still type-checks against Spec["events"], which is the
// contract that matters for consumers.
type LooseSend = (event: string, ...args: unknown[]) => void;

const emitAutoSync = (sdk: SDK, payload: AutoSyncEvent): void => {
  try {
    (sdk.api.send as unknown as LooseSend)("auto-sync", payload);
  } catch (err) {
    sdk.console.error(`jxscout-caido: failed to emit auto-sync event: ${err}`);
  }
};

// Plugin-init auto-launch. Sequenced strictly after recoverOrphan(). Gated on
// the full chain so a user who doesn't want this never has jxscout-pro-v2
// uninvitedly spawn on every Caido start. Each guard logs a one-liner so the
// reason for not auto-launching is debuggable from /tmp/caido-cli.log.
const maybeAutoLaunch = async (sdk: SDK): Promise<void> => {
  const settings = await readCurrentSettings(sdk);
  if (settings.mode !== "managed") {
    sdk.console.log("auto-launch: skipped (mode != managed)");
    return;
  }
  if (!settings.autoLaunch) {
    sdk.console.log("auto-launch: skipped (autoLaunch=false)");
    return;
  }
  // No persisted "user clicked Stop last session" gate -- that state was
  // moved out of settings.json. Within a single Caido process the user can
  // still click Stop and the supervisor stays stopped; across Caido restarts
  // auto-launch fires whenever the other gates pass, on the principle that
  // a fresh Caido session shouldn't inherit a previous session's pause.
  const pro = await hasLicenseFile();
  if (!pro) {
    sdk.console.log("auto-launch: skipped (no license)");
    return;
  }
  const detection = await detectBinary(settings.customBinaryPath);
  if (detection.source === null) {
    sdk.console.log("auto-launch: skipped (binary not detected)");
    return;
  }

  sdk.console.log(
    `auto-launch: starting jxscout-pro-v2 (binary=${detection.path})`
  );
  const result = await startJxscoutHandler(sdk);
  if (!result.success) {
    sdk.console.error(`auto-launch: failed: ${result.error}`);
  } else {
    sdk.console.log(
      `auto-launch: running (pid=${result.pid}, port=${result.port})`
    );
  }
};

// onProjectChange handler. Per Phase 8 plan:
//   - Skip if not managed / autoSync off / supervisor not running.
//   - project === null (Caido project closed): stop jxscout.
//   - project !== null: if normalized name differs from supervisor.project,
//     restart with --project-name=<new>. Emits "auto-sync" event so the
//     frontend can render a transient "Switching project..." pill.
type CaidoProject = {
  getName(): string;
} | null;

const maybeAutoSync = async (
  sdk: SDK,
  project: CaidoProject
): Promise<void> => {
  const settings = await readCurrentSettings(sdk);
  if (settings.mode !== "managed") return;
  if (!settings.autoSync) return;

  const snap = getSupervisorState();
  if (snap.state !== "running" && snap.state !== "starting") {
    // Don't spawn via auto-sync; auto-launch's job. Don't reach into a failed
    // supervisor either -- that's the user's call (Retry button).
    return;
  }

  // Caido project closed. Stop the supervised jxscout per the Phase 8
  // resolution ("Stop jxscout when project closes"). Persist intent='stopped'
  // so a future re-open doesn't auto-launch back into the *previous* project's
  // jxscout -- the user has to either reopen the same project (and click
  // Start) or rely on auto-launch firing on the next Caido boot.
  if (project === null) {
    sdk.console.log("auto-sync: Caido project closed; stopping jxscout");
    emitAutoSync(sdk, { kind: "stopping", from: snap.project });
    await stopJxscoutHandler(sdk);
    return;
  }

  const rawName = typeof project.getName === "function" ? project.getName() : "";
  const desired = normalizeProjectName(rawName.trim());
  if (snap.project !== null && snap.project === desired) {
    // Same project after normalization -- no-op. Defends against onProjectChange
    // firing redundantly (e.g. project metadata updated without a real switch).
    return;
  }

  sdk.console.log(
    `auto-sync: project change ${snap.project ?? "(none)"} -> ${desired}; restarting`
  );
  emitAutoSync(sdk, { kind: "switching", from: snap.project, to: desired });
  const result = await restartJxscoutHandler(sdk);
  if (!result.success) {
    sdk.console.error(`auto-sync: restart failed: ${result.error}`);
  }
};

export type Spec = DefinePluginPackageSpec<{
  manifestId: "jxscout-caido";
  api: {
    saveSettings: (settings: Partial<Settings>) => Promise<Response<Settings>>;
    getSettings: () => Promise<Response<Settings>>;
    getLicense: () => Promise<Response<StoredLicense | null>>;
    setLicense: (key: string) => Promise<Response<StoredLicense>>;
    clearLicense: () => Promise<Response<null>>;
    hasLicense: () => Promise<Response<boolean>>;
    fetchJxscoutStatus: (
      host: string,
      port: number
    ) => Promise<JxscoutStatus | null>;
    detectBinary: () => Promise<DetectionResult>;
    validateBinary: (binaryPath: string) => Promise<ValidationResult>;
    setCustomBinaryPath: (binaryPath: string) => Promise<Response<Settings>>;
    clearCustomBinaryPath: () => Promise<Response<Settings>>;
    startJxscout: () => Promise<StartResult>;
    stopJxscout: () => Promise<StopResult>;
    restartJxscout: () => Promise<StartResult>;
    getSupervisorState: () => Promise<SupervisorSnapshot>;
    downloadBinary: () => Promise<DownloadResult>;
    getReleaseType: () => Promise<ReleaseType | null>;
    listJxscoutProjects: () => Promise<ProjectEntry[] | null>;
    setManualProject: (
      name: string | null
    ) => Promise<Response<{ manualProjectName: string | null }>>;
    getManualProject: () => Promise<
      Response<{ manualProjectName: string | null }>
    >;
    pushScope: (payload: {
      in_scope: string[];
      out_of_scope: string[];
    }) => Promise<Response<null>>;
    fetchScope: () => Promise<
      Response<{ in_scope: string[]; out_of_scope: string[] }>
    >;
    openPath: (payload: {
      path: string;
      tool: "folder" | "vscode" | "cursor";
    }) => Promise<Response<null>>;
  };
  events: {
    "supervisor-state": (snapshot: SupervisorSnapshot) => void;
    "download-progress": (progress: DownloadProgress) => void;
    "auto-sync": (event: AutoSyncEvent) => void;
  };
}>;

export function init(sdk: SDK<Spec>) {
  sdk.api.register("saveSettings", saveSettings);
  sdk.api.register("getSettings", getSettings);
  sdk.api.register("getLicense", getLicenseHandler);
  sdk.api.register("setLicense", setLicenseHandler);
  sdk.api.register("clearLicense", clearLicenseHandler);
  sdk.api.register("hasLicense", hasLicenseHandler);
  sdk.api.register("fetchJxscoutStatus", fetchJxscoutStatus);
  sdk.api.register("detectBinary", detectBinaryHandler);
  sdk.api.register("validateBinary", validateBinaryHandler);
  sdk.api.register("setCustomBinaryPath", setCustomBinaryPathHandler);
  sdk.api.register("clearCustomBinaryPath", clearCustomBinaryPathHandler);
  sdk.api.register("startJxscout", startJxscoutHandler);
  sdk.api.register("stopJxscout", stopJxscoutHandler);
  sdk.api.register("restartJxscout", restartJxscoutHandler);
  sdk.api.register("getSupervisorState", getSupervisorStateHandler);
  sdk.api.register("downloadBinary", downloadBinaryHandler);
  sdk.api.register("getReleaseType", getReleaseTypeHandler);
  sdk.api.register("listJxscoutProjects", listJxscoutProjectsHandler);
  sdk.api.register("setManualProject", setManualProjectHandler);
  sdk.api.register("getManualProject", getManualProjectHandler);
  sdk.api.register("pushScope", pushScopeHandler);
  sdk.api.register("fetchScope", fetchScopeHandler);
  sdk.api.register("openPath", openPathHandler);

  // Phase 6 orphan recovery: if a previous Caido instance crashed while
  // jxscout was running, the child can survive plugin teardown. Read the
  // pid file, SIGTERM if alive, clean up.
  //
  // Phase 8: after orphan recovery, optionally auto-launch. Gated on a full
  // chain so a user who switched to Manual, disabled autoLaunch, removed their
  // license, deleted the binary, OR explicitly clicked Stop most recently does
  // NOT have their machine spawn jxscout uninvitedly on every Caido start.
  // Sequenced strictly after orphan recovery -- otherwise we'd race with
  // SIGTERM-and-pid-file cleanup, and the fresh spawn could land on the same
  // port the orphan was still releasing.
  void (async () => {
    try {
      await recoverOrphan(sdk);
    } catch (err) {
      sdk.console.error(`jxscout-caido: orphan recovery failed: ${err}`);
    }
    try {
      await maybeAutoLaunch(sdk);
    } catch (err) {
      sdk.console.error(`jxscout-caido: auto-launch attempt failed: ${err}`);
    }
  })();

  // Phase 8 auto-sync: follow the Caido project. Skip when not in managed
  // mode, when the user has disabled the toggle, or when the supervisor isn't
  // running (i.e. we don't accidentally start jxscout via auto-sync -- that's
  // auto-launch's job).
  sdk.events.onProjectChange(async (eventSdk, project) => {
    try {
      await maybeAutoSync(eventSdk, project);
    } catch (err) {
      eventSdk.console.error(`jxscout-caido: auto-sync failed: ${err}`);
    }
  });

  sdk.events.onInterceptResponse(async (sdk, request, response) => {
    if (!globalSettings) {
      const settingsResponse = await getSettings(sdk);
      if (settingsResponse.success) {
        globalSettings = settingsResponse.data;
      } else {
        sdk.console.error(
          `jxscout-caido: failed to load settings ${settingsResponse.error}`
        );
        globalSettings = { ...DEFAULT_SETTINGS };
      }
    }

    const settings = globalSettings;

    if (settings.filterInScope && !sdk.requests.inScope(request)) {
      return;
    }

    // Pick the right ingest endpoint at fire time, not from cached
    // settings.json. When the supervisor is running (managed mode active),
    // jxscout is bound to 127.0.0.1 on a port the plugin discovered at
    // start -- live in snap, not in settings, because parallel Caido
    // instances each pick their own port. When the supervisor isn't
    // running we assume manual mode and use the user-configured target.
    const snap = getSupervisorState();
    const isLiveManaged =
      snap.state === "running" &&
      typeof snap.port === "number" &&
      Number.isFinite(snap.port) &&
      snap.port > 0;
    const port = isLiveManaged ? snap.port! : settings.port;
    const host = isLiveManaged
      ? "127.0.0.1"
      : typeof settings.host === "string" && settings.host.trim().length > 0
        ? settings.host
        : "localhost";

    const requestSpec = new RequestSpec("http://" + host);
    requestSpec.setPath("/caido-ingest");
    requestSpec.setPort(port);
    requestSpec.setMethod("POST");
    requestSpec.setHeader("content-type", "application/json");
    requestSpec.setBody(
      JSON.stringify({
        requestUrl: request.getUrl(),
        request: request.getRaw().toText(),
        response: response.getRaw().toText(),
      })
    );

    try {
      await sdk.requests.send(requestSpec, {
        save: false,
      });
    } catch (err) {
      sdk.console.error(`jxscout-caido: failed to send request ${err}`);
    }
  });
}
