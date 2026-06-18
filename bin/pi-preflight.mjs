#!/usr/bin/env node
// bin/pi-preflight.mjs — LLM preflight shim
//
// Reads a JSON fact sheet, calls the user's configured LLM via @earendil-works/pi-ai,
// and prints a structured preflight result to stdout.
//
// This is a THROWAWAY shim. When pi-coding-agent gains an upstream `preflight`
// subcommand, this file moves into the agent and the server just calls
// `pi preflight --facts <file> --source <source>` instead of spawning this
// directly. The logic and prompt live in the agent after that.
//
// Usage:
//   node bin/pi-preflight.mjs --facts <path> --source <npm:name>
//
// Output (stdout): { ok, label, reasoning, alternatives, concerns, model, provider }
// Exit 0 on success, non-zero on failure (with a JSON { ok: false, reason } on stderr).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete, getEnvApiKey, getModel } from "@earendil-works/pi-ai";
import { buildResult, parseArgs, parseLlmResponse } from "./pi-preflight-lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.facts || !args.source) {
    die("usage", "Usage: pi-preflight --facts <file> --source <source>");
}

const agentDir = process.env.PI_CODING_AGENT_DIR
    || (process.platform === "win32"
        ? join(process.env.USERPROFILE || "", ".pi", "agent")
        : join(process.env.HOME || homedir(), ".pi", "agent"));
const settings = readJson(join(agentDir, "settings.json"), null);
const auth     = readJson(join(agentDir, "auth.json"), {});

const provider = settings?.defaultProvider;
const modelId  = settings?.defaultModel;
if (!provider || !modelId) {
    die("no_provider", "settings.json has no defaultProvider/defaultModel");
}

// Lifts the API key from auth.json into the env var that pi-ai expects.
// pi-ai only reads from process.env; the user's pi-agent stores keys in auth.json
// keyed by provider, so we bridge them here. Once the upstream `pi preflight`
// subcommand exists, this step happens inside the agent.
const envMap = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GEMINI_API_KEY",
    "google-vertex": "GOOGLE_CLOUD_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    groq: "GROQ_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    xai: "XAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    zai: "ZAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
    moonshotai: "MOONSHOTAI_API_KEY",
    "moonshotai-cn": "MOONSHOTAI_API_KEY",
    huggingface: "HF_TOKEN",
    fireworks: "FIREWORKS_API_KEY",
    together: "TOGETHER_API_KEY",
    opencode: "OPENCODE_API_KEY",
    "opencode-go": "OPENCODE_API_KEY",
    "kimi-coding": "KIMI_API_KEY",
    "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
    "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
    xiaomi: "XIAOMI_API_KEY",
};
const envVar = envMap[provider];
const authEntry = auth?.[provider];
if (envVar && authEntry?.key && !process.env[envVar]) {
    process.env[envVar] = authEntry.key;
}

if (!getEnvApiKey(provider)) {
    die("no_api_key", `no API key found in auth.json or env for provider '${provider}'`);
}

const facts = readJson(args.facts, null);
if (!facts) die("facts_unreadable", `cannot read facts file: ${args.facts}`);

let model;
try {
    model = getModel(provider, modelId);
} catch (e) {
    die("model_not_found", `getModel(${provider}, ${modelId}) failed: ${e?.message || e}`);
}

const systemPrompt = `You are a pi extension preflight analyzer. The user wants to install a package; you've been given a structured fact sheet about the package, the user's installed stack, the user's environment, and any alternatives from pi.dev/packages.

Your job:

1. Assign a FIT LABEL from exactly this set: "Essential", "Recommended", "Good", "Caution", "Low".
   - Essential:   the user basically needs this — security patch, missing peer-dep, fills a real gap in their stack
   - Recommended: strong fit, well-maintained, broadly useful, low risk
   - Good:        works fine, useful but not a must-have, no major issues
   - Caution:     installable but with real tradeoffs — advisories, conflicts, stale, weak fit
   - Low:         significant issues — abandoned, deprecated, or major conflicts

2. Write a 2-3 sentence REASONING that cites the underlying facts (install counts, last-update, conflicts, fit with stack). Be honest. If the requested package is the best choice, say so — do not invent alternatives just to fill the list.

3. List up to 3 ALTERNATIVES drawn from the provided alternatives list (or your knowledge of pi.dev/packages if the list is empty). For each, a one-line REASON it is better or worse than the requested package. Skip if no good alternative exists.

4. List any CONCERNS not captured in the structured data — philosophical conflicts with the user's stack, surprising behavior, etc.

Respond with ONLY a valid JSON object in this exact shape, no prose, no markdown fences:

{
  "label": "Essential|Recommended|Good|Caution|Low",
  "reasoning": "string",
  "alternatives": [{ "name": "string", "source": "npm:string", "reason": "string" }],
  "concerns": ["string"]
}`;

let result;
try {
    result = await complete(model, {
        systemPrompt,
        messages: [{
            role: "user",
            content: `Fact sheet:\n\n${JSON.stringify(facts, null, 2)}`,
        }],
    });
} catch (e) {
    die("llm_error", `LLM call failed: ${e?.message || e}`);
}

if (result.stopReason && result.stopReason !== "stop" && result.stopReason !== "end_turn") {
    die("llm_stopped", `LLM stopped with reason '${result.stopReason}': ${result.errorMessage || ""}`);
}

const text = (result.content || [])
    .filter((c) => c && c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

if (!text) die("llm_empty", "LLM returned no text content");

const { parsed, raw } = parseLlmResponse(text);
const out = buildResult({
    model: modelId,
    provider,
    parsed,
    raw,
    parseFailed: !parsed,
});
console.log(JSON.stringify(out));

function readJson(path, fallback) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return fallback;
    }
}

function die(reason, message) {
    console.error(JSON.stringify({ ok: false, reason, error: message }));
    process.exit(1);
}
