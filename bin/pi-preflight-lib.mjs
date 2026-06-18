// bin/pi-preflight-lib.mjs — pure helpers extracted from pi-preflight.mjs
//
// No I/O, no network, no process.env mutation. Anything here can be
// imported and unit-tested without spawning a subprocess.

export function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a && a.startsWith('--')) {
            out[a.slice(2)] = argv[i + 1];
            i++;
        }
    }
    return out;
}

const ALLOWED_LABELS = new Set(['Essential', 'Recommended', 'Good', 'Caution', 'Low']);

export function coerceLabel(label) {
    return ALLOWED_LABELS.has(label) ? label : 'Good';
}

export function parseLlmResponse(text) {
    if (!text || typeof text !== 'string') {
        return { parsed: null, raw: '' };
    }
    const cleaned = text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
    if (!cleaned) return { parsed: null, raw: '' };
    try {
        return { parsed: JSON.parse(cleaned), raw: cleaned };
    } catch {
        return { parsed: null, raw: cleaned };
    }
}

export function normalizeAlternatives(alts) {
    if (!Array.isArray(alts)) return [];
    return alts.slice(0, 3).map((a) => ({
        name: String(a?.name || ''),
        source: String(a?.source || `npm:${a?.name || ''}`),
        reason: String(a?.reason || ''),
    }));
}

export function normalizeConcerns(concerns) {
    if (!Array.isArray(concerns)) return [];
    return concerns.map((c) => String(c));
}

// Build the final stdout result the server expects.
// If the LLM returned non-JSON, returns the raw-text fallback so the
// dashboard can still show *something* useful instead of erroring.
export function buildResult({ model, provider, parsed, raw, parseFailed }) {
    if (parseFailed || !parsed || typeof parsed !== 'object') {
        return {
            ok: true,
            label: null,
            reasoning: raw || '',
            alternatives: [],
            concerns: ['Model returned non-JSON; showing raw response.'],
            raw: true,
            model,
            provider,
        };
    }
    return {
        ok: true,
        label: coerceLabel(parsed.label),
        reasoning: String(parsed.reasoning || ''),
        alternatives: normalizeAlternatives(parsed.alternatives),
        concerns: normalizeConcerns(parsed.concerns),
        model,
        provider,
    };
}
