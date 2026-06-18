// test/smoke-e2e.mjs — end-to-end smoke test against the real LLM.
//
// This actually invokes the shim with the user's configured provider/model.
// It WILL spend tokens and cost money. Run deliberately:
//
//     node test/smoke-e2e.mjs                       # default preflight
//     node test/smoke-e2e.mjs npm:pi-lean-ctx       # preflight a specific source
//     node test/smoke-e2e.mjs --model opencode-go/minimax-m3 npm:pi-foo
//
// Exits 0 on a successful round-trip with a parseable LLM response,
// 1 on any failure. Prints the full response JSON for inspection.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SHIM = join(__dirname, '..', 'bin', 'pi-preflight.mjs');

const agentDir = process.env.PI_CODING_AGENT_DIR
    || (process.platform === 'win32'
        ? join(process.env.USERPROFILE || '', '.pi', 'agent')
        : join(process.env.HOME || '', '.pi', 'agent'));

// Parse optional --model <provider/model> flag, then take the source as the
// remaining positional arg. Defaults to npm:pi-lean-ctx (an installed package).
const argv = process.argv.slice(2);
let requestedModel = null;
let source = 'npm:pi-lean-ctx';
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model' && argv[i + 1]) {
        requestedModel = argv[i + 1];
        i++;
    } else if (!argv[i].startsWith('-')) {
        source = argv[i];
    }
}

const tmp = mkdtempSync(join(tmpdir(), 'pf-smoke-'));
const factsFile = join(tmp, 'facts.json');

try {
    // Build a minimal fact sheet — the LLM doesn't need a perfect one
    // for a smoke test; we just need a real LLM call to succeed.
    const facts = {
        requested: {
            source,
            name: source.replace(/^npm:/, ''),
            description: 'Smoke-test package for pi-preflight end-to-end',
            latestVersion: '0.0.0-test',
            lastUpdated: new Date().toISOString(),
            peerDependencies: {},
            keywords: [],
        },
        userStack: {
            count: 13,
            packages: [
                'npm:pi-lean-ctx', 'npm:pi-btw', 'npm:pi-intercom', 'npm:pi-goal',
                'npm:pi-web-access', 'npm:pi-hermes-memory', 'npm:pi-subagents',
                'npm:@gonrocca/zero-pi', 'npm:pi-mcp-adapter', 'npm:pi-paster',
                'npm:pi-markdown-preview', 'npm:@llblab/pi-telegram',
                'npm:pi-package-manager',
            ],
        },
        userEnv: { node: process.version, os: process.platform },
        alternatives: [],
    };
    writeFileSync(factsFile, JSON.stringify(facts, null, 2));

    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
    if (requestedModel) env.PI_MODEL_OVERRIDE = requestedModel;

    console.log(`→ shim: ${SHIM}`);
    console.log(`→ source: ${source}`);
    console.log(`→ agent dir: ${agentDir}`);
    console.log(`→ facts: ${factsFile}`);
    console.log('');

    const t0 = Date.now();
    const r = spawnSync(process.execPath, [SHIM, '--facts', factsFile, '--source', source], {
        encoding: 'utf8',
        env,
        timeout: 90_000,
    });
    const ms = Date.now() - t0;

    console.log(`← exit: ${r.status} (${ms}ms)`);
    if (r.stderr) console.log(`← stderr: ${r.stderr.trim()}`);
    if (r.stdout) console.log(`← stdout: ${r.stdout.trim()}`);
    console.log('');

    if (r.status !== 0) {
        console.error('SMOKE TEST FAILED: shim exited non-zero');
        process.exit(1);
    }

    let parsed;
    try {
        parsed = JSON.parse(r.stdout);
    } catch (e) {
        console.error('SMOKE TEST FAILED: stdout is not valid JSON');
        process.exit(1);
    }

    if (!parsed.ok) {
        console.error(`SMOKE TEST FAILED: shim returned ok:false, reason=${parsed.reason}`);
        process.exit(1);
    }

    console.log('=== Preflight result ===');
    console.log(`label:        ${parsed.label || '(null)'}`);
    console.log(`reasoning:    ${(parsed.reasoning || '').slice(0, 240)}${(parsed.reasoning || '').length > 240 ? '…' : ''}`);
    console.log(`alternatives: ${(parsed.alternatives || []).length}`);
    console.log(`concerns:     ${(parsed.concerns || []).length}`);
    console.log(`raw:          ${parsed.raw ? 'yes (non-JSON LLM output)' : 'no'}`);
    console.log(`model:        ${parsed.model}`);
    console.log(`provider:     ${parsed.provider}`);
    console.log('');
    console.log('SMOKE TEST PASSED');
    process.exit(0);
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
