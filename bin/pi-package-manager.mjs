#!/usr/bin/env node
// pi-package-manager — CLI entry point
// Starts the local bridge server and optionally opens the browser.
//
// Usage:
//   pi-package-manager              Start server + open browser
//   pi-package-manager --no-open    Start server only
//   pi-package-manager --port 9000  Use custom port

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverFile = resolve(__dirname, '..', 'src', 'server.mjs');

const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');
const portIdx = args.indexOf('--port');

if (portIdx !== -1 && args[portIdx + 1]) {
    process.env.PI_PACKAGES_PORT = args[portIdx + 1];
}

if (!fs.existsSync(serverFile)) {
    console.error(`Error: server not found at ${serverFile}`);
    process.exit(1);
}

// Start the server as a child process (inherits stdio so logs show in terminal)
const child = spawn(process.execPath, [serverFile], {
    stdio: 'inherit',
    env: { ...process.env },
    windowsHide: false,
});

// Open browser after a short delay (only if --no-open not passed)
if (!noOpen) {
    const port = process.env.PI_PACKAGES_PORT || '7878';
    const url = `http://127.0.0.1:${port}/`;

    // Wait for server to be ready, then open browser
    const tryOpen = () => {
        import('node:http').then(http => {
            const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 2000 }, () => {
                const cmd = process.platform === 'win32' ? 'cmd' :
                            process.platform === 'darwin' ? 'open' : 'xdg-open';
                const openArgs = process.platform === 'win32'
                    ? ['/c', 'start', '', url]
                    : [url];
                spawn(cmd, openArgs, { stdio: 'ignore', windowsHide: true, detached: true }).unref();
                clearInterval(timer);
            });
            req.on('error', () => {}); // not ready yet, retry
            req.destroy();
        }).catch(() => {});
    };

    tryOpen();
    const timer = setInterval(tryOpen, 500);
    setTimeout(() => clearInterval(timer), 15000);
}

// Forward signals
process.on('SIGINT', () => { child.kill('SIGINT'); });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
child.on('exit', code => { process.exit(code ?? 0); });
