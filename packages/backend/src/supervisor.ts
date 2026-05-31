import type { SDK } from "caido:plugin";
import { fetch } from "caido:http";
import type { ChildProcess } from "child_process";
import { spawn } from "child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as path from "path";

import { validateBinary } from "./binary";

// PID-file isolation per Caido plugin process. Multiple Caido instances can
// share the same Data dir (i.e. the same sdk.meta.path()) and concurrently
// run their own jxscout supervisors. Keying the pid file by the LLRT plugin
// process's pid stops cross-instance orphan recovery from SIGTERMing a
// sibling Caido's still-running jxscout.
//
// Layout under ${sdk.meta.path()}/:
//   managed-pids/<caido-llrt-pid>.pid   -- content: jxscout's pid
const MANAGED_PIDS_DIR = "managed-pids";

const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_POLL_TIMEOUT_MS = 5000;
const HEALTH_FETCH_TIMEOUT_MS = 500;
const STOP_GRACE_MS = 3000;
const ORPHAN_GRACE_MS = 2000;
// Keep enough of jxscout's stderr to surface the actual failure (e.g. SQLite
// lock errors, port-bind panics) when the process exits non-zero. 2KB is
// plenty for one or two stack frames + the error message; large enough to
// be useful, small enough to fit in a UI toast.
const STDERR_TAIL_BYTES = 2048;

const DEFAULT_PORT = 3333;
const PORT_PROBE_RANGE = 50; // 3333..3382

export type SupervisorStateName =
  | "stopped"
  | "starting"
  | "running"
  | "failed";

export type SupervisorSnapshot = {
  state: SupervisorStateName;
  pid: number | null;
  port: number | null;
  startedAt: number | null;
  lastError: string | null;
  manuallyStopped: boolean;
  // Phase 8: the normalized project name the supervisor was spawned with.
  // Auto-sync compares against this on `onProjectChange` so a re-fire with the
  // same value doesn't trigger a no-op restart. Null when stopped.
  project: string | null;
};

export type SupervisorEvents = {
  "supervisor-state": (snapshot: SupervisorSnapshot) => void;
};

export type StartArgs = {
  binaryPath: string;
  project: string;
  port: number;
  defaultProjectsDir?: string | null;
};

// Module-scope mutable state. The supervisor is a singleton per plugin
// install -- there's no meaningful "two managed jxscouts" use case.
// `manuallyStopped` lives here (not in settings.json) so a plugin reload
// resets it: a crashed Caido shouldn't trap the user in "stopped" forever
// across restarts (confirmed Phase 6 decision).
type InternalState = SupervisorSnapshot & {
  child: ChildProcess | null;
  closeWaiters: Array<() => void>;
  healthAbort: AbortController | null;
};

const state: InternalState = {
  state: "stopped",
  pid: null,
  port: null,
  startedAt: null,
  lastError: null,
  manuallyStopped: false,
  project: null,
  child: null,
  closeWaiters: [],
  healthAbort: null,
};

const snapshot = (): SupervisorSnapshot => ({
  state: state.state,
  pid: state.pid,
  port: state.port,
  startedAt: state.startedAt,
  lastError: state.lastError,
  manuallyStopped: state.manuallyStopped,
  project: state.project,
});

export const getSupervisorState = (): SupervisorSnapshot => snapshot();

// ---------------------------------------------------------------------------
// PID file helpers
// ---------------------------------------------------------------------------

const managedPidsDirPath = (sdk: SDK): string =>
  path.join(sdk.meta.path(), MANAGED_PIDS_DIR);

// Names the pid file after THIS Caido backend process's pid (see getOwnPid).
// When the pid is unknown (non-POSIX / lookup failure, getOwnPid -> 0) we fall
// back to a non-numeric sentinel so orphan recovery's `parseInt(owner)` yields
// NaN and skips it rather than mistaking it for a live foreign pid.
const ownPidFilePath = async (sdk: SDK): Promise<string> => {
  const pid = await getOwnPid();
  const owner = pid > 0 ? String(pid) : "unknown";
  return path.join(managedPidsDirPath(sdk), `${owner}.pid`);
};

const writePidFile = async (sdk: SDK, jxscoutPid: number): Promise<void> => {
  await mkdir(managedPidsDirPath(sdk), { recursive: true, mode: 0o700 });
  await writeFile(await ownPidFilePath(sdk), String(jxscoutPid), {
    mode: 0o600,
  });
};

const deletePidFile = async (sdk: SDK): Promise<void> => {
  try {
    // fs/promises in LLRT lacks `unlink`. `rm({force:true})` treats ENOENT as
    // a no-op which is exactly what we want -- the file may already be gone
    // (clean stop, orphan recovery, etc.).
    await rm(await ownPidFilePath(sdk), { force: true });
  } catch (err) {
    sdk.console.error(`supervisor: failed to delete pid file: ${err}`);
  }
};

// ---------------------------------------------------------------------------
// External-process liveness + signalling
//
// LLRT's `process` module doesn't expose `process.kill(pid, sig)` (the
// `process` type only re-exports QuickJS.Signals -- see Phase 5 gotchas), so
// we shell out via `kill(1)` / `taskkill(1)`. spawn-without-shell, args as an
// array, runOnce-style settle on 'close'.
// ---------------------------------------------------------------------------

type ShortSpawnResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
};

const runShort = (
  cmd: string,
  args: readonly string[],
  timeoutMs: number
): Promise<ShortSpawnResult> => {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // swallow
      }
    }, timeoutMs);

    const settle = (exitCode: number | null, errString: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut, error: errString });
    };

    child.stdout?.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.on("error", (err: Error) => {
      settle(null, err.message ?? String(err));
    });
    child.on("close", (code: number | null) => {
      settle(code, null);
    });
  });
};

const isPidAlive = async (pid: number): Promise<boolean> => {
  if (os.platform() === "win32") {
    // `tasklist` with a PID filter; exit 0 + stdout containing the pid line.
    const r = await runShort(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/NH"],
      2000
    );
    return r.exitCode === 0 && r.stdout.includes(String(pid));
  }
  // POSIX: kill -0 <pid> returns 0 if the process exists and we can signal
  // it, 1 otherwise. No actual signal is sent.
  const r = await runShort("kill", ["-0", String(pid)], 1000);
  return r.exitCode === 0;
};

const signalPid = async (
  pid: number,
  signal: "TERM" | "KILL"
): Promise<void> => {
  if (os.platform() === "win32") {
    // SIGTERM has no POSIX semantics on Windows; taskkill /F is the only
    // reliable kill. Acceptable for orphan recovery -- the orphan is
    // already detached.
    await runShort("taskkill", ["/PID", String(pid), "/F"], 2000);
    return;
  }
  await runShort("kill", [`-${signal}`, String(pid)], 1000);
};

// Our own pid -- the Caido backend process. Caido's QuickJS runtime provides
// NO `process` global (a bare `process.pid` throws "process is not defined")
// and does NOT register an importable `process` module (a static `import ...
// from "process"` fails to link and takes the whole backend down). So we can't
// ask the runtime directly. Instead we derive it: a child shell's $PPID is, by
// definition, this process. Resolved once and cached.
//
// POSIX-only. On Windows (no `sh`/$PPID) or any failure we return 0; callers
// degrade gracefully -- the pid file gets a non-numeric name and the jxscout
// `--parent-pid` watchdog is omitted, leaving orphan recovery + explicit stop
// as the backstops.
let ownPidPromise: Promise<number> | null = null;
const getOwnPid = (): Promise<number> => {
  if (ownPidPromise === null) {
    ownPidPromise = (async (): Promise<number> => {
      if (os.platform() === "win32") return 0;
      const r = await runShort("sh", ["-c", "echo $PPID"], 1000);
      const pid = parseInt(r.stdout.trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : 0;
    })();
  }
  return ownPidPromise;
};

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

// Returns true if a listener can bind 127.0.0.1:port right now. Uses net so
// we can actually verify bindability rather than relying on connect-probing
// (which only detects something already serving on that port, not a port
// that's reserved by another process but not yet listening).
const portIsFree = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (free: boolean) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // swallow
      }
      resolve(free);
    };

    let server: net.Server;
    try {
      server = net.createServer();
    } catch {
      resolve(false);
      return;
    }
    server.once("error", () => settle(false));
    server.once("listening", () => settle(true));
    try {
      server.listen(port, "127.0.0.1");
    } catch {
      settle(false);
    }
  });
};

// First free port starting at `start`, scanning at most PORT_PROBE_RANGE
// slots. Returns null if every slot is busy. Caller persists the result.
export const findFreePort = async (
  start: number = DEFAULT_PORT
): Promise<number | null> => {
  const base = Number.isFinite(start) && start > 0 ? Math.floor(start) : DEFAULT_PORT;
  for (let i = 0; i < PORT_PROBE_RANGE; i++) {
    const candidate = base + i;
    if (candidate > 65535) break;
    if (await portIsFree(candidate)) return candidate;
  }
  return null;
};

// ---------------------------------------------------------------------------
// State transitions + event emission
// ---------------------------------------------------------------------------

// Plan calls for emitting only on state-name transitions. Patches that
// accompany a transition (pid, port, startedAt, lastError) are bundled into
// the same event; standalone patches without a state change don't fire.
// SDK<API, Events> defaults to empty maps, so `sdk.api.send` only types in
// the parent Spec (index.ts). The supervisor lives a layer below and would
// either need a circular import or a duplicated Spec generic to get the
// strictly-typed call. Casting once here is the smallest fix; the event
// name + payload are still type-checked against SupervisorEvents at the
// frontend's `onEvent` callsite, which is where the contract actually
// needs to hold for consumers.
type LooseSend = (event: string, ...args: unknown[]) => void;

const emitState = (sdk: SDK, snap: SupervisorSnapshot): void => {
  try {
    (sdk.api.send as unknown as LooseSend)("supervisor-state", snap);
  } catch (err) {
    sdk.console.error(`supervisor: failed to emit state: ${err}`);
  }
};

const transition = (
  sdk: SDK,
  next: SupervisorStateName,
  patch: Partial<SupervisorSnapshot> = {}
): void => {
  const prev = state.state;

  if ("pid" in patch) state.pid = patch.pid ?? null;
  if ("port" in patch) state.port = patch.port ?? null;
  if ("startedAt" in patch) state.startedAt = patch.startedAt ?? null;
  if ("lastError" in patch) state.lastError = patch.lastError ?? null;
  if ("manuallyStopped" in patch) {
    state.manuallyStopped = patch.manuallyStopped ?? false;
  }
  if ("project" in patch) state.project = patch.project ?? null;

  if (prev === next) return;
  state.state = next;
  sdk.console.log(`supervisor: ${prev} -> ${next}`);
  emitState(sdk, snapshot());
};

const resolveCloseWaiters = (): void => {
  const waiters = state.closeWaiters;
  state.closeWaiters = [];
  for (const w of waiters) {
    try {
      w();
    } catch {
      // swallow
    }
  }
};

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

const probeHealthOnce = async (
  port: number,
  signal: AbortSignal
): Promise<boolean> => {
  // Per Phase 4: explicit AbortController + setTimeout. AbortSignal.timeout()
  // segfaulted LLRT under ECONNREFUSED, so the start-time poller (which hits
  // ECONNREFUSED until the child binds) is exactly the kind of call that
  // must not use it.
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => inner.abort(), HEALTH_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: inner.signal,
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });

// Polls GET /health on the configured port until it answers OK or the
// 5-second wall clock elapses. Honours an abort signal so the child's close
// event can short-circuit the wait when spawn fails out from under us.
const waitForHealthy = async (
  port: number,
  signal: AbortSignal
): Promise<boolean> => {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    if (await probeHealthOnce(port, signal)) return true;
    await sleep(HEALTH_POLL_INTERVAL_MS, signal);
  }
  return false;
};

// ---------------------------------------------------------------------------
// Public lifecycle: start / stop / restart
// ---------------------------------------------------------------------------

const buildSpawnArgs = async (a: StartArgs): Promise<string[]> => {
  const args = [
    "--project-name",
    a.project,
    "--proxy-port",
    String(a.port),
    "--headless",
  ];
  // Watchdog: jxscout self-exits if this Caido plugin process dies, so a
  // managed instance is never left dangling -- even on a hard kill of Caido
  // that runs no plugin teardown. Keyed to the same pid as our managed-pids
  // lock files. recoverOrphan() on next launch is the backstop for the gap
  // between Caido's death and the watchdog's next poll. Omitted when our pid
  // is unknown (see getOwnPid) -- orphan recovery then carries the load.
  const ownPid = await getOwnPid();
  if (ownPid > 0) {
    args.push("--parent-pid", String(ownPid));
  }
  const projectsDir =
    typeof a.defaultProjectsDir === "string"
      ? a.defaultProjectsDir.trim()
      : "";
  if (projectsDir.length > 0) {
    args.push("--working-directory", path.join(projectsDir, a.project));
  }
  return args;
};

export type StartResult =
  | { success: true; pid: number; port: number }
  | { success: false; error: string };

// jxscout refuses to open a project that's already locked, printing:
//   Project 'x' is already open in another jxscout instance (PID: 58183)
// We parse that PID so a leftover orphan from a prior session (whose teardown
// raced this launch) can be reaped and the start retried.
const LOCK_CONFLICT_RE =
  /already open in another jxscout instance \(PID:\s*(\d+)\)/i;

const parseLockConflictPid = (msg: string | null | undefined): number | null => {
  if (!msg) return null;
  const m = LOCK_CONFLICT_RE.exec(msg);
  const raw = m?.[1];
  if (!raw) return null;
  const pid = parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
};

// Poll until `pid` is gone, up to `timeoutMs`. True once it's confirmed dead.
const waitForPidDeath = async (
  pid: number,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPidAlive(pid))) return true;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  return !(await isPidAlive(pid));
};

// Reap a jxscout instance by pid ONLY if it's one we manage -- i.e. its pid
// appears in one of our managed-pids files AND that file's owner Caido is us or
// dead. Never touches a foreign/user-run jxscout, nor one owned by a live
// sibling Caido (same rule as recoverOrphan). Returns:
//   "reaped"  - was ours, now dead, pid file removed
//   "alive"   - was ours, survived SIGTERM + SIGKILL
//   "foreign" - not ours (or owned by a live sibling); left untouched
const reapManagedJxscout = async (
  sdk: SDK,
  jxscoutPid: number
): Promise<"reaped" | "alive" | "foreign"> => {
  const dir = managedPidsDirPath(sdk);
  const self = await getOwnPid();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return "foreign";
  }

  for (const entry of entries) {
    if (!entry.endsWith(".pid")) continue;
    let recorded: number | null = null;
    try {
      const raw = await readFile(path.join(dir, entry), "utf-8");
      const n = parseInt(raw.trim(), 10);
      if (Number.isFinite(n) && n > 0) recorded = n;
    } catch {
      continue;
    }
    if (recorded !== jxscoutPid) continue;

    // Found the owning pid file. Don't reap a live sibling Caido's instance.
    const ownerPid = parseInt(entry.slice(0, -".pid".length), 10);
    if (
      Number.isFinite(ownerPid) &&
      ownerPid !== self &&
      (await isPidAlive(ownerPid))
    ) {
      return "foreign";
    }

    if (await isPidAlive(jxscoutPid)) {
      sdk.console.log(
        `supervisor: reaping stale lock-holder jxscout pid=${jxscoutPid} (owner Caido pid=${ownerPid})`
      );
      await signalPid(jxscoutPid, "TERM");
      if (!(await waitForPidDeath(jxscoutPid, ORPHAN_GRACE_MS))) {
        sdk.console.warn(
          `supervisor: lock-holder pid=${jxscoutPid} survived SIGTERM, sending SIGKILL`
        );
        await signalPid(jxscoutPid, "KILL");
        if (!(await waitForPidDeath(jxscoutPid, ORPHAN_GRACE_MS))) return "alive";
      }
    }

    try {
      await rm(path.join(dir, entry), { force: true });
    } catch (err) {
      sdk.console.error(`supervisor: failed to delete pid file ${entry}: ${err}`);
    }
    return "reaped";
  }

  return "foreign";
};

// Public entrypoint. Tries to start; if startup fails purely because the
// project is still locked by a PRIOR jxscout instance we spawned (a leftover
// orphan whose teardown raced this launch), reap it and retry exactly once. A
// lock held by a foreign (user-run) jxscout is surfaced as a clear, actionable
// error instead of the raw "exited with code 1" stderr dump.
export const startJxscout = async (
  sdk: SDK,
  args: StartArgs
): Promise<StartResult> => {
  const first = await startJxscoutOnce(sdk, args);
  if (first.success) return first;

  const lockPid = parseLockConflictPid(first.error);
  if (lockPid === null) return first;

  const outcome = await reapManagedJxscout(sdk, lockPid);
  if (outcome === "foreign") {
    return {
      success: false,
      error: `Project '${args.project}' is already open in another jxscout instance (PID: ${lockPid}) that this plugin didn't start. Close it before launching managed mode.`,
    };
  }
  if (outcome === "alive") {
    return {
      success: false,
      error: `Couldn't free the project lock held by a previous jxscout instance (PID: ${lockPid}).`,
    };
  }

  sdk.console.log(
    `supervisor: reaped stale lock-holder pid=${lockPid}, retrying start`
  );
  return startJxscoutOnce(sdk, args);
};

const startJxscoutOnce = async (
  sdk: SDK,
  args: StartArgs
): Promise<StartResult> => {
  if (state.state === "running" || state.state === "starting") {
    return {
      success: false,
      error: `Supervisor busy: state=${state.state}`,
    };
  }

  if (!args || typeof args.binaryPath !== "string") {
    return { success: false, error: "binaryPath is required" };
  }
  if (typeof args.project !== "string" || args.project.trim().length === 0) {
    return { success: false, error: "project is required" };
  }
  if (!Number.isFinite(args.port) || args.port <= 0) {
    return { success: false, error: `invalid port: ${args.port}` };
  }

  // Validate the binary before spawning. Phase 5 gotcha: discovery and
  // validation are separate steps, and a stale customBinaryPath can survive
  // both. Re-validating here catches "user deleted the binary since last
  // launch" + "user pointed at a non-jxscout binary".
  const validation = await validateBinary(args.binaryPath);
  if (!validation.valid) {
    transition(sdk, "failed", {
      pid: null,
      port: args.port,
      startedAt: null,
      lastError: `Binary invalid: ${validation.error ?? "unknown error"}`,
      manuallyStopped: false,
    });
    return {
      success: false,
      error: validation.error ?? "Binary validation failed",
    };
  }

  const spawnArgs = await buildSpawnArgs(args);
  sdk.console.log(
    `supervisor: spawning ${args.binaryPath} ${spawnArgs.join(" ")}`
  );

  // Clear stale state from a previous failed attempt before re-entering
  // starting. lastError stays cleared until the next failure.
  transition(sdk, "starting", {
    pid: null,
    port: args.port,
    startedAt: null,
    lastError: null,
    manuallyStopped: false,
    project: args.project,
  });

  let child: ChildProcess;
  try {
    child = spawn(args.binaryPath, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    transition(sdk, "failed", {
      lastError: `Spawn threw: ${String(err)}`,
    });
    return { success: false, error: String(err) };
  }

  if (typeof child.pid !== "number") {
    transition(sdk, "failed", {
      lastError: "Spawn returned no pid",
    });
    return { success: false, error: "Spawn returned no pid" };
  }

  state.child = child;
  // Drain stdout to keep the pipe from filling under backpressure. We don't
  // surface plain stdout anywhere (Phase 6 removed the logs feature).
  child.stdout?.on("data", () => {});
  // Keep the tail of stderr so non-zero exits can report *why* jxscout died
  // instead of just "code 1". Ring-buffered to ~2KB so a verbose process
  // that runs for hours doesn't accumulate megabytes of logs.
  let stderrTail = "";
  child.stderr?.on("data", (chunk: unknown) => {
    stderrTail += String(chunk);
    if (stderrTail.length > STDERR_TAIL_BYTES) {
      stderrTail = stderrTail.slice(stderrTail.length - STDERR_TAIL_BYTES);
    }
  });
  const formatStderrSuffix = (): string => {
    const trimmed = stderrTail.trim();
    if (trimmed.length === 0) return "";
    return `: ${trimmed.slice(-STDERR_TAIL_BYTES)}`;
  };

  const healthAbort = new AbortController();
  state.healthAbort = healthAbort;

  child.on("error", (err: Error) => {
    sdk.console.error(`supervisor: child error: ${err.message ?? err}`);
    // 'error' before 'close' typically means spawn failed (e.g. ENOENT).
    // We still expect 'close' to fire shortly; record the message for the
    // close handler to consume.
    if (!state.lastError) {
      state.lastError = err.message ?? String(err);
    }
  });

  child.on("close", async (code: number | null) => {
    const exitCode = code;
    sdk.console.log(`supervisor: child closed with code=${exitCode}`);
    // Stop the health poller if it's still spinning.
    try {
      healthAbort.abort();
    } catch {
      // swallow
    }

    const wasManual = state.manuallyStopped;
    const wasStarting = state.state === "starting";
    const wasRunning = state.state === "running";

    state.child = null;
    state.healthAbort = null;
    await deletePidFile(sdk);

    if (wasManual) {
      // User-initiated stop; the stop handler already set manuallyStopped.
      transition(sdk, "stopped", {
        pid: null,
        startedAt: null,
        project: null,
      });
    } else if (wasStarting) {
      // Died during the /health probe -- likely a spawn failure (bad binary
      // path, port in use, etc.) or an immediate panic.
      transition(sdk, "failed", {
        pid: null,
        startedAt: null,
        lastError:
          state.lastError ??
          `Exited during startup with code ${exitCode ?? "?"}${formatStderrSuffix()}`,
        project: null,
      });
    } else if (wasRunning && exitCode === 0) {
      // Clean exit while running -- treat as stopped, not failed. (E.g.
      // user killed the process with SIGTERM externally.)
      transition(sdk, "stopped", {
        pid: null,
        startedAt: null,
        project: null,
      });
    } else if (wasRunning) {
      transition(sdk, "failed", {
        pid: null,
        startedAt: null,
        lastError: `Exited unexpectedly with code ${exitCode ?? "?"}${formatStderrSuffix()}`,
        project: null,
      });
    }

    resolveCloseWaiters();
  });

  try {
    await writePidFile(sdk, child.pid);
  } catch (err) {
    sdk.console.error(`supervisor: failed to write pid file: ${err}`);
    // Not fatal; orphan recovery will still work via the close event for
    // this session, just not across plugin reloads. Continue.
  }

  const healthy = await waitForHealthy(args.port, healthAbort.signal);
  if (!healthy) {
    // Either the child died (the close handler will run shortly and finish
    // the failed transition) or /health never responded within 5s. Force
    // the latter case forward by killing the child; the close handler then
    // does the state transition.
    if (state.child === child) {
      sdk.console.warn(
        `supervisor: /health did not respond within ${HEALTH_POLL_TIMEOUT_MS}ms; killing child`
      );
      state.lastError = `Health probe timed out after ${HEALTH_POLL_TIMEOUT_MS}ms${formatStderrSuffix()}`;
      try {
        child.kill("SIGKILL");
      } catch {
        // swallow
      }
      // Wait briefly for the close event to settle so the caller gets a
      // failed snapshot, not the in-progress starting one.
      await waitForClose(STOP_GRACE_MS);
    }
    return {
      success: false,
      error: state.lastError ?? "Health probe failed",
    };
  }

  if (state.child !== child) {
    // The child closed during the probe window; the close handler already
    // settled state into failed/stopped. Return the recorded error.
    return {
      success: false,
      error: state.lastError ?? "Child exited during startup",
    };
  }

  transition(sdk, "running", {
    pid: child.pid,
    port: args.port,
    startedAt: Date.now(),
    lastError: null,
    manuallyStopped: false,
  });

  return { success: true, pid: child.pid, port: args.port };
};

const waitForClose = (timeoutMs: number): Promise<boolean> => {
  if (!state.child) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (closed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(closed);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    state.closeWaiters.push(() => {
      clearTimeout(timer);
      settle(true);
    });
  });
};

export type StopResult =
  | { success: true }
  | { success: false; error: string };

export const stopJxscout = async (sdk: SDK): Promise<StopResult> => {
  if (state.state === "stopped") {
    // Already stopped; clear lastError so a previous failure doesn't linger
    // in the UI after the user explicitly stops.
    if (state.lastError) {
      state.lastError = null;
      emitState(sdk, snapshot());
    }
    state.manuallyStopped = true;
    return { success: true };
  }

  const child = state.child;
  if (!child) {
    // State says running/starting/failed but no child object -- treat as a
    // forced reset to stopped.
    transition(sdk, "stopped", {
      pid: null,
      startedAt: null,
      manuallyStopped: true,
      project: null,
    });
    return { success: true };
  }

  state.manuallyStopped = true;

  try {
    child.kill("SIGTERM");
  } catch (err) {
    sdk.console.error(`supervisor: SIGTERM threw: ${err}`);
  }

  const closed = await waitForClose(STOP_GRACE_MS);
  if (!closed && state.child) {
    sdk.console.warn(
      `supervisor: child did not exit within ${STOP_GRACE_MS}ms, sending SIGKILL`
    );
    try {
      state.child.kill("SIGKILL");
    } catch (err) {
      sdk.console.error(`supervisor: SIGKILL threw: ${err}`);
    }
    await waitForClose(STOP_GRACE_MS);
  }

  return { success: true };
};

export const restartJxscout = async (
  sdk: SDK,
  args: StartArgs
): Promise<StartResult> => {
  if (state.state !== "stopped") {
    const stopRes = await stopJxscout(sdk);
    if (!stopRes.success) {
      return { success: false, error: stopRes.error };
    }
  }
  // stopJxscout sets manuallyStopped; clear it so a subsequent auto-launch
  // (Phase 8) treats the restart as an intentional fresh start.
  state.manuallyStopped = false;
  return startJxscout(sdk, args);
};

// ---------------------------------------------------------------------------
// Orphan recovery (plugin init)
//
// We scan ${sdk.meta.path()}/managed-pids/*.pid. Each file is named after a
// Caido plugin-process pid (the owner) and contains the jxscout pid it
// supervises. For each:
//   - owner pid still alive AND not us  -> sibling Caido is running; leave alone
//   - owner pid is us (stale file from a previous run with the same pid, or
//     left over after a hard crash) -> treat as orphan, SIGTERM jxscout, delete
//   - owner pid is dead              -> orphan, SIGTERM jxscout, delete
//
// Pid reuse can in theory cause us to leave a stale file in place a bit too
// long (owner-pid got recycled by some unrelated OS process). That's a
// cosmetic leak, not a correctness bug -- jxscout's actual pid is checked
// separately before we signal it.
// ---------------------------------------------------------------------------

export const recoverOrphan = async (sdk: SDK): Promise<void> => {
  const dir = managedPidsDirPath(sdk);
  const self = await getOwnPid();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Dir doesn't exist yet -- no recovery needed.
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".pid")) continue;
    const ownerPid = parseInt(entry.slice(0, -".pid".length), 10);
    if (!Number.isFinite(ownerPid) || ownerPid <= 0) continue;

    // Owner alive and not us -> sibling Caido is running its own jxscout.
    // Don't touch it. (Pid reuse: if some unrelated OS process happens to
    // have grabbed this pid, we'll leak the file until the real owner
    // exits. Acceptable -- the jxscout pid inside isn't signalled either,
    // and the file is overwritten next time we hit this pid ourselves.)
    if (ownerPid !== self && (await isPidAlive(ownerPid))) {
      continue;
    }

    const fullPath = path.join(dir, entry);
    let jxscoutPid: number | null = null;
    try {
      const raw = await readFile(fullPath, "utf-8");
      const n = parseInt(raw.trim(), 10);
      if (Number.isFinite(n) && n > 0) jxscoutPid = n;
    } catch {
      // unreadable -- skip the signal step, just delete below
    }

    if (jxscoutPid !== null && (await isPidAlive(jxscoutPid))) {
      sdk.console.log(
        `supervisor: orphan jxscout pid=${jxscoutPid} (owner Caido pid=${ownerPid} ${
          ownerPid === self ? "is us, file is stale" : "is dead"
        }), SIGTERM`
      );
      await signalPid(jxscoutPid, "TERM");

      const deadline = Date.now() + ORPHAN_GRACE_MS;
      while (Date.now() < deadline) {
        if (!(await isPidAlive(jxscoutPid))) break;
        await new Promise<void>((r) => setTimeout(r, 200));
      }
      if (await isPidAlive(jxscoutPid)) {
        sdk.console.warn(
          `supervisor: orphan pid=${jxscoutPid} survived SIGTERM, sending SIGKILL`
        );
        await signalPid(jxscoutPid, "KILL");
      }
    }

    try {
      await rm(fullPath, { force: true });
    } catch (err) {
      sdk.console.error(
        `supervisor: failed to delete stale pid file ${fullPath}: ${err}`
      );
    }
  }
};
