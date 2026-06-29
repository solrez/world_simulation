// OpenRouter provider. One key, one endpoint, many models. Each call may carry
// its own `model` (so different agents think with different models). Cheap open
// models are less disciplined about JSON than OpenAI, so parsing is tolerant:
// strip markdown fences and extract the first balanced {...} object.

const DEFAULT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'qwen/qwen3.6-flash';
const TIMEOUT_MS = 20000; // a slow free-tier model shouldn't stall an agent forever

// Models that returned a hard "this model doesn't exist" error (404 / 400). These
// slugs churn on OpenRouter, and a dead one would otherwise 404 on every single
// tick — spamming the console and wasting a round-trip per agent forever. Once a
// model is known-dead we stop sending it and transparently fall back, so one
// retired slug can't degrade the whole sim. Module-level so it's shared across
// all calls for the session.
const deadModels = new Set();
// Status codes that mean "this exact model can't be served" (vs. transient 429/5xx
// which we must NOT blacklist — those should keep retrying).
const DEAD_STATUSES = new Set([400, 404]);
// Sentinel distinguishing "model is dead, fall back" from "call failed, return null".
const DEAD = Symbol('dead-model');

// Pull the first JSON object out of a model reply, tolerating ```json fences,
// leading prose, and trailing commentary. Returns null if nothing parses.
function extractJSON(text) {
  if (!text) return null;
  // try the easy path first
  try { return JSON.parse(text); } catch { /* fall through */ }
  // strip code fences
  let s = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  // grab the first balanced {...} block
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    else if (!inStr) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      } }
    }
  }
  return null;
}

export class OpenRouterProvider {
  constructor(config = {}) {
    this.apiKey = config.apiKey || import.meta.env.VITE_OPENROUTER_API_KEY;
    this.url = config.url || DEFAULT_URL;
    this.defaultModel = config.model || import.meta.env.VITE_OPENROUTER_MODEL || DEFAULT_MODEL;
  }

  async complete({ system, user, temperature = 0.9, maxTokens = 500, model, signal }) {
    if (!this.apiKey) return null;

    const requested = model || this.defaultModel;
    // If the requested model is known-dead, don't even try it — go straight to the
    // default (unless the default is itself dead, in which case bail to reflex).
    let useModel = deadModels.has(requested) ? this.defaultModel : requested;
    if (deadModels.has(useModel)) return null;

    const result = await this._send({ system, user, temperature, maxTokens, model: useModel, signal });

    // A dead-model response on a non-default model: blacklist it and retry ONCE
    // with the default so this agent's turn still gets a real answer.
    if (result === DEAD && useModel !== this.defaultModel && !deadModels.has(this.defaultModel)) {
      return await this._send({ system, user, temperature, maxTokens, model: this.defaultModel, signal })
        .then(r => (r === DEAD ? null : r));
    }
    return result === DEAD ? null : result;
  }

  // One HTTP round-trip. Returns parsed JSON, the DEAD sentinel if the model is
  // unavailable (so the caller can blacklist + fall back), or null on any other
  // failure (transient error, timeout, abort, unparseable reply).
  async _send({ system, user, temperature, maxTokens, model, signal }) {
    // combine the caller's abort signal with a per-call timeout
    const timer = new AbortController();
    const to = setTimeout(() => timer.abort(), TIMEOUT_MS);
    if (signal) signal.addEventListener('abort', () => timer.abort(), { once: true });

    try {
      const resp = await fetch(this.url, {
        method: 'POST',
        signal: timer.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          // OpenRouter asks for these; harmless if omitted, nice for dashboards.
          'HTTP-Referer': 'http://localhost:5173',
          'X-Title': 'Village Life',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature, max_tokens: maxTokens,
          // Ask for JSON; models that don't support it ignore the field, which is
          // why parsing is tolerant rather than relying on this.
          response_format: { type: 'json_object' },
        }),
      });
      if (!resp.ok) {
        if (DEAD_STATUSES.has(resp.status)) {
          // retire this slug for the rest of the session (warn only on first sight)
          if (!deadModels.has(model)) {
            deadModels.add(model);
            console.warn(`OpenRouter: model "${model}" unavailable (${resp.status}) — retiring it and falling back.`);
          }
          return DEAD;
        }
        console.warn(`OpenRouter error (${model}):`, resp.status);
        return null;
      }
      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content;
      return extractJSON(text);
    } catch (e) {
      if (e.name !== 'AbortError') console.warn(`AI error (${model}):`, e.message);
      return null;
    } finally {
      clearTimeout(to);
    }
  }
}
