// test/test-shim.mjs — unit tests for pi-preflight-lib
//
// Pure-logic tests only. No network, no LLM, no real fs writes outside
// of mkdtempSync scratch dirs. Uses node:test (built-in, no deps).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parseArgs,
    parseLlmResponse,
    coerceLabel,
    normalizeAlternatives,
    normalizeConcerns,
    buildResult,
} from '../bin/pi-preflight-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SHIM = join(__dirname, '..', 'bin', 'pi-preflight.mjs');

// --- parseArgs ------------------------------------------------------------

test('parseArgs extracts --key value pairs', () => {
    assert.deepEqual(
        parseArgs(['--facts', '/tmp/x.json', '--source', 'npm:foo']),
        { facts: '/tmp/x.json', source: 'npm:foo' },
    );
});

test('parseArgs ignores non-flag tokens', () => {
    assert.deepEqual(parseArgs(['node', 'shim.mjs', '--source', 'npm:foo']), { source: 'npm:foo' });
});

test('parseArgs returns empty object for empty input', () => {
    assert.deepEqual(parseArgs([]), {});
});

test('parseArgs handles flag with no following value', () => {
    // --flag at end of argv with no value is dropped (or set to undefined)
    const r = parseArgs(['--flag']);
    assert.ok('flag' in r);
});

// --- coerceLabel ----------------------------------------------------------

test('coerceLabel accepts the five allowed labels', () => {
    for (const l of ['Essential', 'Recommended', 'Good', 'Caution', 'Low']) {
        assert.equal(coerceLabel(l), l);
    }
});

test('coerceLabel downgrades any other label to Good', () => {
    assert.equal(coerceLabel('GREAT'), 'Good');
    assert.equal(coerceLabel('high'), 'Good');
    assert.equal(coerceLabel(null), 'Good');
    assert.equal(coerceLabel(undefined), 'Good');
    assert.equal(coerceLabel(42), 'Good');
});

// --- parseLlmResponse -----------------------------------------------------

test('parseLlmResponse parses clean JSON', () => {
    const { parsed, raw } = parseLlmResponse('{"label":"Good","reasoning":"x"}');
    assert.deepEqual(parsed, { label: 'Good', reasoning: 'x' });
    assert.equal(raw, '{"label":"Good","reasoning":"x"}');
});

test('parseLlmResponse strips ```json fences', () => {
    const { parsed, raw } = parseLlmResponse('```json\n{"label":"Good"}\n```');
    assert.deepEqual(parsed, { label: 'Good' });
    assert.equal(raw, '{"label":"Good"}');
});

test('parseLlmResponse strips ``` fences (no language tag)', () => {
    const { parsed, raw } = parseLlmResponse('```\n{"label":"Low"}\n```');
    assert.deepEqual(parsed, { label: 'Low' });
});

test('parseLlmResponse returns parsed:null on garbage', () => {
    const { parsed, raw } = parseLlmResponse('This is not JSON at all.');
    assert.equal(parsed, null);
    assert.equal(raw, 'This is not JSON at all.');
});

test('parseLlmResponse handles empty string', () => {
    const { parsed, raw } = parseLlmResponse('');
    assert.equal(parsed, null);
    assert.equal(raw, '');
});

test('parseLlmResponse handles non-string', () => {
    const { parsed, raw } = parseLlmResponse(null);
    assert.equal(parsed, null);
    assert.equal(raw, '');
});

// --- normalizeAlternatives ------------------------------------------------

test('normalizeAlternatives keeps at most 3 entries', () => {
    const alts = [
        { name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' },
    ];
    assert.equal(normalizeAlternatives(alts).length, 3);
});

test('normalizeAlternatives fills source from name when missing', () => {
    const out = normalizeAlternatives([{ name: 'pi-foo', reason: 'x' }]);
    assert.deepEqual(out[0], { name: 'pi-foo', source: 'npm:pi-foo', reason: 'x' });
});

test('normalizeAlternatives respects provided source', () => {
    const out = normalizeAlternatives([{ name: 'pi-foo', source: 'npm:@scope/pi-foo', reason: 'x' }]);
    assert.equal(out[0].source, 'npm:@scope/pi-foo');
});

test('normalizeAlternatives coerces non-array to []', () => {
    assert.deepEqual(normalizeAlternatives(null), []);
    assert.deepEqual(normalizeAlternatives('x'), []);
});

// --- normalizeConcerns ----------------------------------------------------

test('normalizeConcerns stringifies entries', () => {
    assert.deepEqual(normalizeConcerns([1, 'two', null]), ['1', 'two', 'null']);
});

test('normalizeConcerns coerces non-array to []', () => {
    assert.deepEqual(normalizeConcerns(undefined), []);
});

// --- buildResult ----------------------------------------------------------

test('buildResult returns raw fallback when parseFailed', () => {
    const r = buildResult({
        model: 'foo', provider: 'p', parsed: null, raw: 'oops', parseFailed: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.label, null);
    assert.equal(r.reasoning, 'oops');
    assert.equal(r.raw, true);
    assert.equal(r.model, 'foo');
});

test('buildResult returns raw fallback when parsed is non-object', () => {
    const r = buildResult({
        model: 'm', provider: 'p', parsed: 'not an object', raw: 'not an object', parseFailed: false,
    });
    assert.equal(r.raw, true);
    assert.equal(r.label, null);
});

test('buildResult normalizes a valid parsed object', () => {
    const r = buildResult({
        model: 'm', provider: 'p',
        parsed: { label: 'Recommended', reasoning: 'r', alternatives: [{ name: 'a' }], concerns: ['c'] },
        raw: '', parseFailed: false,
    });
    assert.equal(r.label, 'Recommended');
    assert.equal(r.reasoning, 'r');
    assert.equal(r.alternatives.length, 1);
    assert.deepEqual(r.concerns, ['c']);
    assert.equal(r.raw, undefined);
});

test('buildResult coerces invalid labels to Good', () => {
    const r = buildResult({
        model: 'm', provider: 'p',
        parsed: { label: 'AMAZING', reasoning: 'r' },
        raw: '', parseFailed: false,
    });
    assert.equal(r.label, 'Good');
});

// --- shim subprocess behavior (no LLM, just arg handling) -----------------

test('shim exits 1 with usage when args are missing', () => {
    const r = spawnSync(process.execPath, [SHIM], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage/i);
});

test('shim exits 1 with reason=no_provider when settings is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-test-'));
    try {
        writeFileSync(join(dir, 'settings.json'), '{}');
        writeFileSync(join(dir, 'auth.json'), '{}');
        const r = spawnSync(process.execPath, [SHIM, '--facts', join(dir, 'x.json'), '--source', 'npm:foo'], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: dir,
            },
        });
        assert.equal(r.status, 1);
        const last = r.stderr.trim().split(/\r?\n/).filter(Boolean).pop();
        const j = JSON.parse(last);
        assert.equal(j.reason, 'no_provider');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('shim exits 1 with reason=no_api_key when settings has provider but auth is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-test-'));
    try {
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'opencode-go', defaultModel: 'minimax-m3' }));
        writeFileSync(join(dir, 'auth.json'), '{}');
        const facts = { requested: {}, userStack: {}, userEnv: {}, alternatives: [] };
        const factsFile = join(dir, 'facts.json');
        writeFileSync(factsFile, JSON.stringify(facts));
        const r = spawnSync(process.execPath, [SHIM, '--facts', factsFile, '--source', 'npm:foo'], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: dir,
            },
        });
        assert.equal(r.status, 1);
        const last = r.stderr.trim().split(/\r?\n/).filter(Boolean).pop();
        const j = JSON.parse(last);
        assert.equal(j.reason, 'no_api_key');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
