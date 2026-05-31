import type { SDK } from "caido:plugin";
import { fetch } from "caido:http";
import { spawn, type ChildProcess } from "child_process";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";

import { readLicense } from "./license";

// Marketing site's v2 download endpoint. Resolver pattern:
//   GET https://jxscout.app/api/v2/download?type={releaseType}&version=latest&licenseKey={key}
//   -> { downloadUrl, version }
// `downloadUrl` is a Keygen-validated R2 presigned URL pointing at a tar.gz
// (Unix) or .zip (Windows). Tarball contents are a single top-level file:
// `jxscout-pro-v2` (Unix) or `jxscout-pro-v2.exe` (Windows). See
// bun/marketing-website/src/app/api/v2/download/route.ts + scripts/local-release.sh.
const RESOLVER_BASE_URL = "https://jxscout.app/api/v2/download";

// Floor for the binary version we'll install. If the resolver's `latest`
// answer is below this (which can happen if the marketing site's
// LATEST_VERSION_CLI_V2 constant lags behind an uploaded release), we re-ask
// for this version explicitly. Bumped here when the plugin starts depending
// on features only present in a newer jxscout-pro-v2 (e.g. the runtime
// POST /scope endpoint landed in 2.1.2).
const MIN_BINARY_VERSION = "2.1.2";

// Lightweight semver-ish comparator. Parses major.minor.patch off the front
// and treats anything trailing (e.g. "-beta18", "-rc1") as a pre-release,
// which sorts *below* the same X.Y.Z without a suffix. That matches semver's
// pre-release rule and is sufficient for the resolver's version vocabulary:
//
//   "2.1.2"        -> not lower
//   "2.1.2-rc1"    -> lower (pre-release of same X.Y.Z)
//   "2.1.0"        -> lower
//   "2.0.0-beta18" -> lower
//   "2.1.3"        -> not lower
//
// Unparseable inputs are conservatively treated as lower so we upgrade rather
// than ship whatever malformed thing the resolver returned.
const isVersionLowerThanMin = (version: string): boolean => {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version);
  if (!match) return true;
  const have: [number, number, number] = [
    parseInt(match[1] ?? "0", 10),
    parseInt(match[2] ?? "0", 10),
    parseInt(match[3] ?? "0", 10),
  ];
  const wantParts = MIN_BINARY_VERSION.split(".");
  const want: [number, number, number] = [
    parseInt(wantParts[0] ?? "0", 10),
    parseInt(wantParts[1] ?? "0", 10),
    parseInt(wantParts[2] ?? "0", 10),
  ];
  for (let i = 0; i < 3; i++) {
    if (have[i]! < want[i]!) return true;
    if (have[i]! > want[i]!) return false;
  }
  // Numeric prefix equals MIN_BINARY_VERSION -- only "lower" if it carries
  // a pre-release suffix.
  return (match[4] ?? "").startsWith("-");
};

// Phase 4 LLRT lesson: AbortSignal.timeout(ms) segfaults the runtime when
// fetch fails with ECONNREFUSED. Same risk profile here (offline at install
// time is plausible). Use explicit AbortController + setTimeout, clearTimeout
// in finally.
const RESOLVER_TIMEOUT_MS = 10_000;
// Download timeout has to be generous: ~50MB over a slow connection. 10
// minutes is the wall clock; the user can cancel via abort if they need to.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 60_000;

const MANAGED_DIR = ".jxscout-pro";
const MANAGED_BIN_SUBDIR = "bin";
const BINARY_NAME_UNIX = "jxscout-pro-v2";
const BINARY_NAME_WIN = "jxscout-pro-v2.exe";

export type DownloadProgress =
  | { kind: "resolving" }
  | { kind: "downloading"; bytes: number; total: number | null }
  | { kind: "extracting" }
  | { kind: "installing" }
  | { kind: "done"; path: string; version: string }
  | { kind: "error"; error: string };

export type ReleaseType =
  | "linux-386"
  | "linux-amd64"
  | "linux-arm64"
  | "macos-amd64"
  | "macos-arm64"
  | "windows-amd64"
  | "windows-arm64";

export type DownloadResult =
  | { success: true; path: string; version: string }
  | { success: false; error: string };

// Maps Node-style os.platform()/os.arch() to the ReleaseType strings the
// marketing site recognises. Returns null when the host platform isn't a
// supported jxscout-pro-v2 target (e.g. freebsd, openbsd, sunos).
//
// LLRT exposes Node-shape values: os.platform() ∈ {darwin,linux,win32},
// os.arch() ∈ {x64,arm64,ia32}. "ia32" is the only oddball: marketing site
// calls this "linux-386".
export const releaseTypeForCurrentPlatform = (): ReleaseType | null => {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === "darwin") {
    if (arch === "arm64") return "macos-arm64";
    if (arch === "x64") return "macos-amd64";
    return null;
  }
  if (platform === "linux") {
    if (arch === "arm64") return "linux-arm64";
    if (arch === "x64") return "linux-amd64";
    if (arch === "ia32") return "linux-386";
    return null;
  }
  if (platform === "win32") {
    if (arch === "arm64") return "windows-arm64";
    if (arch === "x64") return "windows-amd64";
    return null;
  }
  return null;
};

const managedBinDir = (): string =>
  path.join(os.homedir(), MANAGED_DIR, MANAGED_BIN_SUBDIR);

const finalBinaryPath = (): string =>
  path.join(
    managedBinDir(),
    os.platform() === "win32" ? BINARY_NAME_WIN : BINARY_NAME_UNIX
  );

const archiveExtensionForPlatform = (): "zip" | "tar.gz" =>
  os.platform() === "win32" ? "zip" : "tar.gz";

// LLRT's `sdk.api.send` types as `never` at this layer because the parent
// Spec lives in index.ts and importing it would create a circular dep. The
// frontend's `onEvent` still type-checks against Spec["events"], so the
// contract holds where consumers actually live. Same trick the supervisor
// uses for "supervisor-state".
type LooseSend = (event: string, ...args: unknown[]) => void;

const emit = (sdk: SDK, progress: DownloadProgress): void => {
  try {
    (sdk.api.send as unknown as LooseSend)("download-progress", progress);
  } catch (err) {
    sdk.console.error(`download: failed to emit progress: ${err}`);
  }
};

// Resolver call: validates the license + maps {type, version} to an R2
// presigned URL. Failure modes: 400 (bad type), 401 (invalid license), 500
// (R2 issue) -- surface the server's `error` field verbatim so the user
// sees the real reason.
type ResolverResponse = {
  downloadUrl: string;
  version: string;
};

const resolveDownloadUrl = async (
  sdk: SDK,
  releaseType: ReleaseType,
  licenseKey: string,
  version: string
): Promise<ResolverResponse> => {
  const url =
    `${RESOLVER_BASE_URL}` +
    `?type=${encodeURIComponent(releaseType)}` +
    `&version=${encodeURIComponent(version)}` +
    `&licenseKey=${encodeURIComponent(licenseKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // swallow
    }
  }, RESOLVER_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const raw = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        raw && typeof raw === "object" && "error" in raw &&
        typeof (raw as { error: unknown }).error === "string"
          ? (raw as { error: string }).error
          : `HTTP ${response.status}`;
      throw new Error(`Resolver rejected request: ${message}`);
    }
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof (raw as { downloadUrl?: unknown }).downloadUrl !== "string" ||
      typeof (raw as { version?: unknown }).version !== "string"
    ) {
      throw new Error("Resolver returned a malformed payload");
    }
    return raw as ResolverResponse;
  } catch (err) {
    sdk.console.error(`download: resolver call failed: ${err}`);
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
};

// caido:http's Response.body is `null` (NOT a ReadableStream), so streaming
// to disk isn't possible -- we have to buffer the whole body via
// arrayBuffer(). For a ~50MB binary this is fine inside LLRT/QuickJS.
//
// Caveat: the progress event can only report start+end, not byte-by-byte.
// We emit a single `downloading` event with `total` from Content-Length (so
// the frontend can show "Downloading 52 MB..." instead of an indefinite
// spinner) before awaiting the bytes. When `total` is unknown we emit null.
const downloadArchiveToDisk = async (
  sdk: SDK,
  downloadUrl: string,
  destPath: string
): Promise<void> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // swallow
    }
  }, DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(downloadUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Download HTTP ${response.status}`);
    }

    const contentLength = response.headers.get("content-length");
    const total =
      contentLength !== null && /^\d+$/.test(contentLength)
        ? parseInt(contentLength, 10)
        : null;
    emit(sdk, { kind: "downloading", bytes: 0, total });

    const buffer = await response.arrayBuffer();
    emit(sdk, {
      kind: "downloading",
      bytes: buffer.byteLength,
      total: total ?? buffer.byteLength,
    });

    await writeFile(destPath, new Uint8Array(buffer));
  } finally {
    clearTimeout(timer);
  }
};

// Spawn-with-timeout helper, runOnce-style. Same shape Phase 5/6 settled on:
// no shell, argv array, manual setTimeout + child.kill('SIGKILL') for
// wall-clock enforcement, `close` (not `exit`) as the settle event.
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

// `tar` ships with macOS, Linux, and modern Windows (since Win10 1803 — it's
// bsdtar under the hood and handles both .tar.gz and .zip). Using one tool
// across all three avoids a `unzip`-on-Windows availability question.
const extractArchive = async (
  archivePath: string,
  extractDir: string
): Promise<void> => {
  const args =
    archiveExtensionForPlatform() === "tar.gz"
      ? ["-xzf", archivePath, "-C", extractDir]
      : ["-xf", archivePath, "-C", extractDir];
  const result = await runShort("tar", args, EXTRACT_TIMEOUT_MS);
  if (result.timedOut) {
    throw new Error(`tar timed out after ${EXTRACT_TIMEOUT_MS}ms`);
  }
  if (result.error) {
    throw new Error(`tar spawn failed: ${result.error}`);
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 400);
    throw new Error(`tar exited ${result.exitCode}${detail ? `: ${detail}` : ""}`);
  }
};

// On macOS, freshly-downloaded binaries inherit the
// `com.apple.quarantine` extended attribute, which makes Gatekeeper block
// the first launch ("cannot be verified"). Strip it best-effort. Skip
// entirely on Linux/Windows (no xattr there, attempting would just log
// noise).
const stripQuarantineAttribute = async (
  sdk: SDK,
  targetPath: string
): Promise<void> => {
  if (os.platform() !== "darwin") return;
  const result = await runShort(
    "xattr",
    ["-d", "com.apple.quarantine", targetPath],
    5000
  );
  // xattr exits non-zero when the attribute isn't set, which is fine.
  if (result.exitCode !== 0 && result.exitCode !== null) {
    sdk.console.log(
      `download: xattr strip non-fatal exit ${result.exitCode} (likely no quarantine to strip)`
    );
  }
};

// Locate the binary inside the extracted dir. The release tarballs/zips
// contain a single top-level file matching `jxscout-pro-v2[.exe]`. Fall back
// to a one-level-deep search in case future releases nest the file (eg
// under a versioned dirname).
const locateExtractedBinary = async (extractDir: string): Promise<string> => {
  const target =
    os.platform() === "win32" ? BINARY_NAME_WIN : BINARY_NAME_UNIX;

  const top = await readdir(extractDir, { withFileTypes: true });
  for (const entry of top) {
    if (entry.isFile() && entry.name === target) {
      return path.join(extractDir, entry.name);
    }
  }
  for (const entry of top) {
    if (entry.isDirectory()) {
      const inner = await readdir(path.join(extractDir, entry.name), {
        withFileTypes: true,
      });
      for (const child of inner) {
        if (child.isFile() && child.name === target) {
          return path.join(extractDir, entry.name, child.name);
        }
      }
    }
  }
  throw new Error(`Binary '${target}' not found in extracted archive`);
};

// installBinary owns the post-download chain: extract, locate, move-into-place,
// chmod, strip xattr. Phase 7 question: the user chose to put this all in one
// spot rather than two RPCs. Keeping the public surface narrow -- downloadBinary
// does the whole thing.
const installBinary = async (
  sdk: SDK,
  archivePath: string
): Promise<string> => {
  emit(sdk, { kind: "extracting" });

  const binDir = managedBinDir();
  await mkdir(binDir, { recursive: true, mode: 0o755 });

  const extractDir = await mkdtemp(
    path.join(os.tmpdir(), "jxscout-pro-extract-")
  );

  try {
    await extractArchive(archivePath, extractDir);
    const extractedBinary = await locateExtractedBinary(extractDir);

    emit(sdk, { kind: "installing" });

    const finalPath = finalBinaryPath();
    // rename across the same filesystem is atomic. If the old binary is
    // currently running, rename still succeeds on Unix (the running process
    // holds an open fd to the old inode); the new file simply takes its
    // place for future launches. On Windows this fails with EBUSY, so try
    // to rm the existing file first and let rename create fresh.
    await rm(finalPath, { force: true });
    await rename(extractedBinary, finalPath);

    if (os.platform() !== "win32") {
      await chmod(finalPath, 0o755);
    }
    await stripQuarantineAttribute(sdk, finalPath);

    return finalPath;
  } finally {
    // Best-effort cleanup of the temp extract dir.
    try {
      await rm(extractDir, { recursive: true, force: true });
    } catch (err) {
      sdk.console.log(`download: temp dir cleanup failed (ignored): ${err}`);
    }
  }
};

// Public entry point. Reads the license, resolves the download URL, fetches
// the archive, extracts, installs. Emits progress events at each stage. All
// failure modes collapse into DownloadResult — the frontend has a single
// shape to render against.
export const downloadBinary = async (sdk: SDK): Promise<DownloadResult> => {
  try {
    emit(sdk, { kind: "resolving" });

    const releaseType = releaseTypeForCurrentPlatform();
    if (releaseType === null) {
      const message = `Unsupported platform: ${os.platform()}/${os.arch()}`;
      emit(sdk, { kind: "error", error: message });
      return { success: false, error: message };
    }

    const license = await readLicense();
    if (!license || license.license_key.length === 0) {
      const message = "No license on disk; activate first";
      emit(sdk, { kind: "error", error: message });
      return { success: false, error: message };
    }

    let resolved = await resolveDownloadUrl(
      sdk,
      releaseType,
      license.license_key,
      "latest"
    );

    // If the resolver answered with a version below our floor, retry with an
    // explicit version pin so we don't install a binary missing features the
    // plugin depends on. Best-effort: if the retry fails (e.g. the pinned
    // version isn't in the resolver's allowlist), fall back to whatever
    // `latest` already gave us rather than failing the whole install.
    if (isVersionLowerThanMin(resolved.version)) {
      sdk.console.log(
        `download: resolver returned ${resolved.version}; retrying for ${MIN_BINARY_VERSION}`
      );
      try {
        resolved = await resolveDownloadUrl(
          sdk,
          releaseType,
          license.license_key,
          MIN_BINARY_VERSION
        );
      } catch (err) {
        sdk.console.error(
          `download: pinned-version retry failed (${err}); keeping ${resolved.version}`
        );
      }
    }

    const binDir = managedBinDir();
    await mkdir(binDir, { recursive: true, mode: 0o755 });
    const tmpArchivePath = path.join(
      binDir,
      `.download.${archiveExtensionForPlatform()}`
    );

    try {
      await downloadArchiveToDisk(sdk, resolved.downloadUrl, tmpArchivePath);
      const finalPath = await installBinary(sdk, tmpArchivePath);
      emit(sdk, { kind: "done", path: finalPath, version: resolved.version });
      return { success: true, path: finalPath, version: resolved.version };
    } finally {
      // Always clean up the temp archive (success or failure). Ignore errors;
      // the file may already be gone if installBinary moved it.
      try {
        await rm(tmpArchivePath, { force: true });
      } catch {
        // swallow
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sdk.console.error(`downloadBinary failed: ${message}`);
    emit(sdk, { kind: "error", error: message });
    return { success: false, error: message };
  }
};
