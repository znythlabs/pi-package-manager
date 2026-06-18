// pi-package-manager server (bundled with the pi-package-manager extension)
// Local bridge that serves the dashboard HTML and exposes install/uninstall
// endpoints backed by the real `pi` CLI. No external dependencies.
//
//   GET  /                       -> dashboard HTML
//   GET  /api/state              -> { ok, sources: { "npm:<name>": true, ... }, count }
//   GET  /api/health             -> { ok, agentDir }
//   POST /api/install   {source} -> runs `pi install <source>`
//   POST /api/uninstall {source} -> runs `pi remove <source>`
//   POST /api/preflight  {source}         -> LLM preflight result (fact sheet + analysis)
//   POST /api/force-install {source, phrase} -> install after typed-confirm; audit-logged
//
// Bound to 127.0.0.1 only. Launched by the /packages slash command
// (or directly: `node src/server.mjs`). Then open http://127.0.0.1:7878/.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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

// Resolve the full path to the `pi` binary once at startup so we can spawn
// it directly with shell:false. This avoids Node's DEP0190 deprecation
// ("Passing args to a child process with shell option true can lead to
// security vulnerabilities") and is more correct on Windows where `pi`
// is a .cmd shim that needs the full extension to be invoked directly.
function findPiOnPath() {
    const isWin = process.platform === 'win32';
    const probe = isWin ? 'where' : 'which';
    try {
        const r = spawnSync(probe, ['pi'], { encoding: 'utf8', windowsHide: true });
        if (r.status !== 0) return null;
        const candidates = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (candidates.length === 0) return null;
        if (!isWin) return candidates[0];
        // On Windows, prefer .cmd / .bat / .exe over no-extension. The bare
        // `pi` entry npm installs can be a POSIX shell script that Windows
        // can't spawn directly with shell:false. The .cmd shim is what
        // cmd.exe would actually invoke via PATHEXT.
        const withExt = candidates.find(c => /\.(cmd|bat|exe|com)$/i.test(c));
        return withExt || candidates[0];
    } catch {
        return null;
    }
}
const PI_CMD = findPiOnPath();

// --- Preflight + force-install plumbing -------------------------------------

const PREFLIGHT_SHIM = path.join(__dirname, '..', 'bin', 'pi-preflight.mjs');
const AUDIT_LOG = path.join(AGENT_DIR, 'pi-packages-audit.log');
const FACTS_TTL = 5 * 60_000;       // cache npm/pi.dev metadata for 5 min
const FORCE_PHRASE = 'I understand the risks';
const factsCache = new Map();       // source -> { ts, data }

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
        // Spawn strategy:
        //   - If we resolved a real .exe / no-extension binary: spawn it
        //     directly with shell:false. No DEP0190.
        //   - If we resolved a Windows .cmd / .bat shim (the common case
        //     for npm-installed CLIs): Node 18+ refuses to spawn .cmd
        //     files with shell:false (EINVAL). The clean way to invoke
        //     them is `cmd.exe /c <cmd> <args>` with shell:false on our
        //     spawn — Node handles the Windows command-line escaping for
        //     us, and DEP0190 is not triggered because we never set
        //     shell:true ourselves.
        //   - Fallback: bare 'pi' with shell:true. SOURCE_RE ensures
        //     args are safe to concatenate into a shell string.
        const cmd = PI_CMD || 'pi';
        const isWin = process.platform === 'win32';
        const isWindowsScript = isWin && /\.(cmd|bat)$/i.test(cmd);
        let child;
        if (isWindowsScript) {
            child = spawn('cmd.exe', ['/c', cmd, ...args], {
                cwd: HOME,
                shell: false,
                windowsHide: true,
            });
        } else {
            child = spawn(cmd, args, {
                cwd: HOME,
                shell: !PI_CMD,  // shell:true only as a last-resort fallback
                windowsHide: true,
            });
        }
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

// Fetch npm registry metadata for a package, with a tight timeout.
// Returns a partial fact sheet on any failure rather than throwing — a
// missing or rate-limited registry must not block the whole preflight.
async function fetchNpmMeta(pkgName) {
    const empty = { name: pkgName, error: 'unavailable' };
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`, {
            headers: { Accept: 'application/json' },
            signal: ctl.signal,
        });
        clearTimeout(t);
        if (!r.ok) return { ...empty, error: 'http_' + r.status };
        const j = await r.json();
        const latest = j['dist-tags'] && j['dist-tags'].latest;
        const v = (latest && j.versions && j.versions[latest]) || {};
        return {
            name: j.name || pkgName,
            description: j.description || v.description || '',
            latestVersion: latest || '',
            author: (j.author && (typeof j.author === 'string' ? j.author : j.author.name)) || '',
            lastUpdated: (latest && j.time && j.time[latest]) || (j.time && j.time.modified) || '',
            homepage: j.homepage || '',
            keywords: Array.isArray(j.keywords) ? j.keywords : [],
            peerDependencies: v.peerDependencies || {},
            engines: v.engines || {},
            deprecated: !!(latest && v.deprecated),
        };
    } catch (e) {
        return { ...empty, error: String(e && e.message || e) };
    }
}

// Alternatives come from pi.dev/packages. There is no documented public search
// API yet, so we return an empty list and rely on the LLM's knowledge of the
// pi extension ecosystem. When pi.dev exposes search, this is the place to wire it.
async function fetchPiDevAlternatives(_pkgName, _meta) {
    return [];
}

// Gather a fact sheet for `source` (e.g. 'npm:pi-foo'). Cached for FACTS_TTL.
// The user stack snapshot is read fresh on every call so a just-installed
// extension is reflected immediately; only the npm/pi.dev metadata is cached.
async function gatherFacts(source) {
    const cached = factsCache.get(source);
    if (cached && (Date.now() - cached.ts) < FACTS_TTL) {
        // Stack is always fresh, even on cache hit
        cached.data.userStack = snapshotStack();
        return cached.data;
    }
    const pkgName = source.replace(/^npm:/, '');
    const [npmMeta, alternatives] = await Promise.all([
        fetchNpmMeta(pkgName),
        fetchPiDevAlternatives(pkgName, null),
    ]);
    const data = {
        requested: { source, ...npmMeta },
        userStack: snapshotStack(),
        userEnv: { node: process.version, os: process.platform, pi: readPiVersion() },
        alternatives,
    };
    factsCache.set(source, { ts: Date.now(), data });
    return data;
}

function snapshotStack() {
    const installed = readInstalled();
    return { count: installed.size, packages: [...installed].sort() };
}

function readPiVersion() {
    // Same strategy as runPi: prefer the resolved PI_CMD with shell:false,
    // use cmd.exe /c on Windows for .cmd shims, fall back to shell:true only
    // if PI_CMD couldn't be resolved at startup.
    if (!PI_CMD) {
        try {
            const r = spawnSync('pi', ['--version'], { encoding: 'utf8', shell: true, windowsHide: true });
            return (r.stdout || '').trim() || 'unknown';
        } catch { return 'unknown'; }
    }
    const isWin = process.platform === 'win32';
    const isWindowsScript = isWin && /\.(cmd|bat)$/i.test(PI_CMD);
    try {
        const r = isWindowsScript
            ? spawnSync('cmd.exe', ['/c', PI_CMD, '--version'], { encoding: 'utf8', shell: false, windowsHide: true })
            : spawnSync(PI_CMD, ['--version'], { encoding: 'utf8', shell: false, windowsHide: true });
        return (r.stdout || '').trim() || 'unknown';
    } catch {
        return 'unknown';
    }
}

function invalidateFacts(source) {
    if (source) factsCache.delete(source);
    else factsCache.clear();
}

// Spawn the LLM preflight shim. Returns { ok, parsed, stderr, ms }.
// The shim is a tiny wrapper around @earendil-works/pi-ai and prints
// structured JSON to stdout. We pass the facts via a temp file to keep
// argv short and to avoid shell quoting.
function runPreflightShim(factsFile, source) {
    const t0 = Date.now();
    return new Promise((resolve) => {
        if (!fs.existsSync(PREFLIGHT_SHIM)) {
            return resolve({ ok: false, code: -1, stdout: '', stderr: `preflight shim missing at ${PREFLIGHT_SHIM}`, ms: 0 });
        }
        const child = spawn(process.execPath, [PREFLIGHT_SHIM, '--facts', factsFile, '--source', source], {
            cwd: HOME,
            shell: false,
            windowsHide: true,
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; if (stdout.length > 1e6) child.kill(); });
        child.stderr.on('data', d => { stderr += d; });
        // LLM calls can be slow but shouldn't take more than 60s.
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
        }, 60_000);
        child.on('error', err => {
            clearTimeout(timer);
            resolve({ ok: false, code: -1, stdout, stderr: String(err), ms: Date.now() - t0 });
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ ok: code === 0, code: code ?? -1, stdout, stderr, ms: Date.now() - t0 });
        });
    });
}

// Append a force-install event to the audit log. The log lives in the agent
// dir so the user can grep it. Format is line-oriented JSON-ish for greppability.
function auditForceInstall(source) {
    const line = `${new Date().toISOString()} | source=${source} | action=force-install | confirmed=typed-phrase\n`;
    try {
        fs.appendFileSync(AUDIT_LOG, line, 'utf8');
    } catch (e) {
        console.error(`[${ts()}] audit log write failed: ${e.message}`);
    }
    console.log(`[${ts()}] AUDIT ${line.trim()}`);
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
        if (result.ok) invalidateFacts(source);  // stack changed; drop cached facts for this source
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

    // Preflight — gather facts, spawn the LLM shim, return its JSON result.
    // Sync: the dashboard awaits the full result before rendering.
    if (req.method === 'POST' && p === '/api/preflight') {
        const body = await readBody(req);
        const source = String(body.source || '').trim();
        if (!SOURCE_RE.test(source)) {
            return send(res, 400, { ok: false, error: 'invalid source' });
        }
        console.log(`[${ts()}] preflight ${source}`);
        let facts;
        try {
            facts = await gatherFacts(source);
        } catch (e) {
            return send(res, 500, { ok: false, reason: 'facts_failed', error: String(e.message || e) });
        }
        const tmp = path.join(os.tmpdir(), `pi-preflight-${process.pid}-${Date.now()}.json`);
        fs.writeFileSync(tmp, JSON.stringify(facts));
        let shim;
        try {
            shim = await runPreflightShim(tmp, source);
        } finally {
            try { fs.unlinkSync(tmp); } catch {}
        }
        if (!shim.ok) {
            // Shim exits non-zero on auth / model / parse failures and prints
            // a JSON { ok:false, reason } on stderr. Surface that to the UI.
            let reason = 'llm_unavailable';
            let error = shim.stderr;
            try {
                const last = shim.stderr.trim().split(/\r?\n/).filter(Boolean).pop();
                if (last) {
                    const j = JSON.parse(last);
                    if (j && j.reason) reason = j.reason;
                    if (j && j.error) error = j.error;
                }
            } catch {}
            console.log(`[${ts()}]   -> preflight failed reason=${reason}`);
            return send(res, 503, { ok: false, reason, error, ms: shim.ms });
        }
        let parsed;
        try {
            parsed = JSON.parse(shim.stdout);
        } catch (e) {
            return send(res, 500, { ok: false, reason: 'shim_parse', error: String(e.message || e) });
        }
        console.log(`[${ts()}]   -> preflight ok label=${parsed.label} (${shim.ms}ms)`);
        return send(res, 200, { ok: true, source, ...parsed, facts, ms: shim.ms });
    }

    // Force-install — install without preflight, only after the user types the
    // confirmation phrase. Audit-logged to ~/.pi/agent/pi-packages-audit.log.
    if (req.method === 'POST' && p === '/api/force-install') {
        const body = await readBody(req);
        const source = String(body.source || '').trim();
        const phrase = String(body.phrase || '');
        if (!SOURCE_RE.test(source)) {
            return send(res, 400, { ok: false, error: 'invalid source' });
        }
        if (phrase !== FORCE_PHRASE) {
            return send(res, 400, { ok: false, error: 'phrase_mismatch', expected: FORCE_PHRASE });
        }
        console.log(`[${ts()}] force-install ${source}`);
        auditForceInstall(source);
        const result = await runPi(['install', source]);
        const next = stateObject();
        invalidateFacts(source);
        console.log(`[${ts()}]   -> force-install code=${result.code} ok=${result.ok} (${result.ms}ms)`);
        return send(res, result.ok ? 200 : 500, {
            ok: result.ok,
            code: result.code,
            action: 'force-install',
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
    console.log(`  pi cmd    : ${PI_CMD || '<not on PATH — install/uninstall will use shell fallback>'}`);
    console.log('  Ctrl+C to stop.');
    console.log('');
});
