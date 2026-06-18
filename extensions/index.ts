// pi-package-manager — Pi extension entry point
// Registers the /packages slash command which launches the local bridge
// server (src/server.mjs) and opens the dashboard in the user's browser.
//
// Server lifecycle:
//   - spawned on /packages invocation
//   - reused on subsequent invocations (idempotent)
//   - killed on session_shutdown

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "..", "src", "server.mjs");
const PORT = parseInt(process.env.PI_PACKAGES_PORT || "7878", 10);
const URL = `http://127.0.0.1:${PORT}/`;

let serverProc: ChildProcess | null = null;
let starting = false;

function openBrowser(): void {
    const cmd =
        process.platform === "win32" ? "cmd" :
        process.platform === "darwin" ? "open" :
        "xdg-open";
    const args = process.platform === "win32"
        ? ["/c", "start", "", URL]
        : [URL];
    try {
        spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
    } catch {
        // best-effort — fall through to manual URL message
    }
}

function isUp(): boolean {
    if (!serverProc) return false;
    // ChildProcess exposes `killed`/`exitCode`; treat either as dead.
    return (serverProc.exitCode === null) && !serverProc.killed;
}

async function ensureServer(): Promise<{ ok: boolean; reason?: string }> {
    if (isUp()) return { ok: true };
    if (starting) return { ok: true }; // a parallel invocation is launching it
    if (!existsSync(SERVER)) {
        return { ok: false, reason: `server bundle missing at ${SERVER} — reinstall pi-package-manager` };
    }
    starting = true;
    try {
        serverProc = spawn(process.execPath, [SERVER], {
            stdio: "ignore",
            detached: false,
            windowsHide: true,
            env: { ...process.env },
        });
        serverProc.on("exit", () => {
            if (serverProc && (serverProc as ChildProcess).exitCode !== 0) {
                // intentionally silent — the user can /packages again to restart
            }
            serverProc = null;
        });
        // Give the listener a moment to bind the port.
        await new Promise((r) => setTimeout(r, 600));
        return { ok: true };
    } catch (e) {
        serverProc = null;
        return { ok: false, reason: String((e as Error).message ?? e) };
    } finally {
        starting = false;
    }
}

export default function (pi: ExtensionAPI): void {
    pi.registerCommand("packages", {
        description: "Open the installed packages dashboard at http://127.0.0.1:7878/",
        handler: async (_args, ctx) => {
            const r = await ensureServer();
            if (!r.ok) {
                ctx.ui.notify(`pi-package-manager: ${r.reason}`, "error");
                return;
            }
            openBrowser();
            ctx.ui.notify(`Dashboard running at ${URL}`, "info");
        },
    });

    pi.registerCommand("packages-stop", {
        description: "Stop the local pi-package-manager dashboard server",
        handler: async (_args, ctx) => {
            if (!serverProc) {
                ctx.ui.notify("pi-package-manager: no server running", "info");
                return;
            }
            try { serverProc.kill(); } catch { /* ignore */ }
            serverProc = null;
            ctx.ui.notify("pi-package-manager: server stopped", "info");
        },
    });

    pi.on("session_shutdown", () => {
        if (serverProc) {
            try { serverProc.kill(); } catch { /* ignore */ }
            serverProc = null;
        }
    });
}
