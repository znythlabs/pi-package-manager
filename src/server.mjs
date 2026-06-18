// pi-package-manager server (bundled with the pi-package-manager extension)
// Local bridge that serves the dashboard HTML and exposes install/uninstall
// endpoints backed by the real `pi` CLI. No external dependencies.
//
//   GET  /                  -> dashboard HTML
//   GET  /api/state         -> { ok, sources: { "npm:<name>": true, ... }, count }
//   POST /api/install   {source} -> runs `pi install <source>`
//   POST /api/uninstall {source} -> runs `pi remove <source>`
//
// Bound to 127.0.0.1 only. Launched by the /packages slash command
// (or directly: `node src/server.mjs`). Then open http://127.0.0.1:7878/.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.pi', 'agent');
const SETTINGS = path.join(AGENT_DIR, 'settings.json');

// HTML resolution: env var → personal copy in ~/.pi/agent → bundled.
// The personal copy is what `update_pi_packages.py` regenerates, so users
// running the regen flow get their updated catalog without republishing.
const BUNDLED_HTML = path.join(__dirname, 'pi-packages.html');
const PERSONAL_HTML = path.join(AGENT_DIR, 'pi-packages.html');
const HTML_FILE = process.env.PI_PACKAGES_HTML
    || (fs.existsSync(PERSONAL_HTML) ? PERSONAL_HTML : BUNDLED_HTML);

const PORT = parseInt(process.env.PI_PACKAGES_PORT || '7878', 10);
const HOST = '127.0.0.1';
const HOME = process.env.USERPROFILE || process.env.HOME || AGENT_DIR;

// Strict source allowlist — anything else is rejected before it reaches the shell.
const SOURCE_RE = /^npm:@?[a-z0-9][\w.-]*(\/[a-z0-9][\w.-]*)?$/i;

function ts() {
    return new Date().toISOString().slice(11, 19);
}

function readInstalled() {
    try {
        const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
        const arr = Array.isArray(s.packages) ? s.packages : [];
        return new Set(arr.filter(x => typeof x === 'string'));
    } catch (e) {
        console.error(`[${ts()}] settings read failed: ${e.message}`);
        return new Set();
    }
}

function stateObject() {
    const installed = readInstalled();
    const sources = {};
    for (const s of installed) sources[s] = true;
    return { ok: true, sources, count: installed.size };
}

function send(res, status, body, headers = {}) {
    const h = {
        'Cache-Control': 'no-store',
        // Allow the page to call us even when opened as file://
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        ...headers,
    };
    if (!h['Content-Type']) h['Content-Type'] = 'application/json; charset=utf-8';
    res.writeHead(status, h);
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
        req.on('error', () => resolve({}));
    });
}

function runPi(args) {
    const t0 = Date.now();
    return new Promise((resolve) => {
        // shell:true so Windows resolves pi.cmd from PATH. Source is allowlisted.
        const child = spawn('pi', args, {
            cwd: HOME,
            shell: true,
            windowsHide: true,
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
        }, 180000);
        child.on('error', err => {
            clearTimeout(timer);
            resolve({ ok: false, code: -1, stdout: '', stderr: String(err), ms: Date.now() - t0 });
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ ok: code === 0, code: code ?? -1, stdout, stderr, ms: Date.now() - t0 });
        });
    });
}

const server = http.createServer(async (req, res) => {
    // Preflight for file://-opened page
    if (req.method === 'OPTIONS') return send(res, 204, '');
    let url;
    try { url = new URL(req.url, `http://${HOST}`); } catch { return send(res, 400, { ok: false, error: 'bad url' }); }
    const p = url.pathname;

    // Serve the UI
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        try {
            const html = fs.readFileSync(HTML_FILE, 'utf8');
            return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
        } catch (e) {
            return send(res, 500, { ok: false, error: 'HTML not found: ' + e.message });
        }
    }

    // State
    if (req.method === 'GET' && p === '/api/state') {
        return send(res, 200, stateObject());
    }

    // Install / uninstall
    if (req.method === 'POST' && (p === '/api/install' || p === '/api/uninstall')) {
        const body = await readBody(req);
        const source = String(body.source || '').trim();
        if (!SOURCE_RE.test(source)) {
            return send(res, 400, { ok: false, error: 'invalid source' });
        }
        const action = p === '/api/install' ? 'install' : 'remove';
        console.log(`[${ts()}] ${action} ${source}`);
        const result = await runPi([action, source]);
        const next = stateObject();
        console.log(`[${ts()}]   -> code=${result.code} ok=${result.ok} installed=${next.sources[source] ? 'yes' : 'no'} (${result.ms}ms)`);
        return send(res, result.ok ? 200 : 500, {
            ok: result.ok,
            code: result.code,
            action,
            source,
            stdout: result.stdout.slice(0, 6000),
            stderr: result.stderr.slice(0, 6000),
            installed: !!next.sources[source],
            sources: next.sources,
            count: next.count,
        });
    }

    // Health
    if (req.method === 'GET' && p === '/api/health') {
        return send(res, 200, { ok: true, pi: true, agentDir: AGENT_DIR });
    }

    return send(res, 404, { ok: false, error: 'not found' });
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} already in use — is pi-package-manager already running?`);
    } else {
        console.error('Server error:', e.message);
    }
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  pi-package-manager server');
    console.log(`  → http://${HOST}:${PORT}/`);
    console.log(`  agent dir : ${AGENT_DIR}`);
    console.log(`  settings  : ${SETTINGS}`);
    console.log(`  html      : ${HTML_FILE}${HTML_FILE === PERSONAL_HTML ? '  (personal override)' : ''}`);
    console.log('  Ctrl+C to stop.');
    console.log('');
});
