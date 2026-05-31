export type Mode = "manual" | "managed";

export type Settings = {
    // Manual-mode connection target. The plugin POSTs/GETs to
    // http://{host}:{port}/... when the user runs jxscout themselves.
    // Managed mode ignores both: it binds 127.0.0.1 and auto-allocates the
    // port at every supervisor start.
    host: string;
    port: number;
    filterInScope: boolean;
    mode: Mode;
    customBinaryPath: string | null;
    defaultProjectsDir: string | null;
    autoLaunch: boolean;
    autoSync: boolean;
}

export type ProjectEntry = {
    name: string;
    path: string;
}

export type StoredLicense = {
    license_key: string;
    machine_fingerprint: string | null;
}

// Mirrors HealthResponse in crates/core/proxy-api/src/handlers.rs.
export type JxscoutStatus = {
    status: string;
    project: string;
    working_directory: string;
    version: string;
}

export type Response<T> = {
    success: true;
    data: T;
} | {
    success: false;
    error: string;
}
