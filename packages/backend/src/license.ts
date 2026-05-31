import { mkdir, readFile, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";

import { StoredLicense } from "./types";

const LICENSE_DIR_NAME = ".jxscout-pro";
const LICENSE_FILE_NAME = ".license";

export const licensePath = (): string =>
    path.join(os.homedir(), LICENSE_DIR_NAME, LICENSE_FILE_NAME);

export const readLicense = async (): Promise<StoredLicense | null> => {
    let raw: string;
    try {
        raw = await readFile(licensePath(), "utf-8");
    } catch {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== "object") {
        return null;
    }
    const obj = parsed as Record<string, unknown>;

    if (typeof obj.license_key !== "string" || obj.license_key.length === 0) {
        return null;
    }

    const machineFingerprint =
        typeof obj.machine_fingerprint === "string" ? obj.machine_fingerprint : null;

    return {
        license_key: obj.license_key,
        machine_fingerprint: machineFingerprint,
    };
};

export const writeLicense = async (key: string): Promise<void> => {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
        throw new Error("License key cannot be empty");
    }

    const filePath = licensePath();
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    // Preserve machine_fingerprint when the key is unchanged so jxscout-pro-v2
    // doesn't have to re-validate via Keygen. Reset to null on a key change.
    let machineFingerprint: string | null = null;
    const existing = await readLicense();
    if (existing && existing.license_key === trimmed) {
        machineFingerprint = existing.machine_fingerprint;
    }

    const payload: StoredLicense = {
        license_key: trimmed,
        machine_fingerprint: machineFingerprint,
    };

    await writeFile(filePath, JSON.stringify(payload), { mode: 0o600 });
};

export const clearLicense = async (): Promise<void> => {
    // `force: true` makes rm a no-op when the file is already missing.
    await rm(licensePath(), { force: true });
};

export const hasLicense = async (): Promise<boolean> => {
    const license = await readLicense();
    return license !== null;
};
