import { spawn } from "child_process";
import { access } from "fs/promises";
import * as os from "os";
import * as path from "path";

const BINARY_NAME = "jxscout-pro-v2";
const MANAGED_DIR = ".jxscout-pro";
const MANAGED_BIN_SUBDIR = "bin";

const VALIDATE_TIMEOUT_MS = 2000;
const WHICH_TIMEOUT_MS = 2000;

export type BinarySource = "custom" | "path" | "managed";

export type DetectionResult =
  | { source: BinarySource; path: string }
  | { source: null; path: null };

export type ValidationResult = {
  valid: boolean;
  version?: string;
  error?: string;
};

const managedBinaryPath = (): string =>
  path.join(os.homedir(), MANAGED_DIR, MANAGED_BIN_SUBDIR, BINARY_NAME);

const fileAccessible = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// Runs a command and captures stdout / stderr / exit. Always uses an array of
// args (no shell substitution). Enforces a wall-clock timeout via setTimeout +
// child.kill() so a hung subprocess never wedges the RPC. Failures are returned
// instead of thrown so callers don't have to wrap us in try/catch -- matching
// the "collapse to null" discipline used by fetchJxscoutStatus.
//
// Discipline (carried over from Phase 4):
// - No `{ shell: true }` -- caller passes exact argv. A malicious string in
//   `cmd` cannot inject shell metacharacters because there's no shell.
// - No AbortSignal.timeout(): manual setTimeout + clearTimeout in finally.
//   AbortSignal.timeout() segfaulted LLRT during Phase 4.
type SpawnResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
};

const runOnce = (
  cmd: string,
  args: readonly string[],
  timeoutMs: number
): Promise<SpawnResult> => {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";

    let child;
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
        // swallow -- the process may have just exited.
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

// Spawns `<binaryPath> --version`, 2s timeout, returns whether it looks like a
// jxscout build. Per Phase 5 decision the match is RELAXED: any output
// containing "jxscout" (case-insensitive) counts. This is friendlier during
// dogfooding when the dev binary is `tui` (which would not start with
// "jxscout-pro" but does include the project name in its banner).
//
// Phase 8: the released jxscout-pro-v2 2.1.1 predates clap `--version` (added
// in jxscout-rs#42), so it rejects the flag with "unexpected argument
// '--version'" (exit 2). We treat that specific stderr pattern as a soft
// success -- `version` is left empty and the real version surfaces via
// /health post-spawn. Auto-launch and Start on a fresh-install 2.1.1 binary
// both work; if the user has typed a non-jxscout binary path that happens to
// reject --version, the /health probe rejects it within the 5s start window.
const UNEXPECTED_VERSION_FLAG = /unexpected argument.*--version/i;

export const validateBinary = async (
  binaryPath: string
): Promise<ValidationResult> => {
  if (typeof binaryPath !== "string" || binaryPath.trim().length === 0) {
    return { valid: false, error: "Empty binary path" };
  }
  // Pre-check accessibility so the error attributes the failure correctly
  // (otherwise a missing file shows up as an opaque ENOENT spawn error).
  if (!(await fileAccessible(binaryPath))) {
    return { valid: false, error: `Path not accessible: ${binaryPath}` };
  }

  const result = await runOnce(binaryPath, ["--version"], VALIDATE_TIMEOUT_MS);
  if (result.timedOut) {
    return {
      valid: false,
      error: `--version timed out after ${VALIDATE_TIMEOUT_MS}ms`,
    };
  }
  if (result.error) {
    return { valid: false, error: result.error };
  }
  if (result.exitCode !== 0) {
    const combined = `${result.stderr}\n${result.stdout}`;
    // Pre-2.1.2 binary: clap rejects --version. Accept as a soft-valid;
    // /health will be the authoritative version source post-spawn.
    if (UNEXPECTED_VERSION_FLAG.test(combined)) {
      return { valid: true, version: undefined };
    }
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 200);
    return {
      valid: false,
      error: `--version exited ${result.exitCode}${detail ? `: ${detail}` : ""}`,
    };
  }
  const stdout = result.stdout.trim();
  if (!/jxscout/i.test(stdout)) {
    return {
      valid: false,
      error: `--version output does not contain "jxscout": ${stdout.slice(0, 200)}`,
    };
  }
  return { valid: true, version: stdout };
};

const detectViaWhich = async (): Promise<string | null> => {
  // `which` on Unix, `where` on Windows. Both write the resolved path(s) to
  // stdout, one per line. `where` may emit multiple matches; we take the first.
  const tool = os.platform() === "win32" ? "where" : "which";
  const result = await runOnce(tool, [BINARY_NAME], WHICH_TIMEOUT_MS);
  if (result.timedOut || result.exitCode !== 0 || result.error) {
    return null;
  }
  const firstLine = result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!firstLine) return null;
  if (!(await fileAccessible(firstLine))) return null;
  return firstLine;
};

// Discovery order matches the plan: custom path → which/where → managed dir.
// A custom path that no longer exists silently falls through to the next
// source rather than returning null -- this lets a user who removed the file
// recover via PATH or the managed install without first clearing the setting.
export const detectBinary = async (
  customPath?: string | null
): Promise<DetectionResult> => {
  const trimmed =
    typeof customPath === "string" ? customPath.trim() : "";
  if (trimmed.length > 0 && (await fileAccessible(trimmed))) {
    return { source: "custom", path: trimmed };
  }

  const fromPath = await detectViaWhich();
  if (fromPath) {
    return { source: "path", path: fromPath };
  }

  const managed = managedBinaryPath();
  if (await fileAccessible(managed)) {
    return { source: "managed", path: managed };
  }

  return { source: null, path: null };
};
