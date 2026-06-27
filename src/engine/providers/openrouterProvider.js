// OpenRouter provider. One key, one endpoint, many models. Each call may carry
// its own `model` (so different agents think with different models). Cheap open
// models are less disciplined about JSON than OpenAI, so parsing is tolerant:
// strip markdown fences and extract the first balanced {...} object.

const DEFAULT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'meta-llama/llama-3.1-8b-instruct';
const TIMEOUT_MS = 20000; // a slow free-tier model shouldn't stall an agent forever

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
    const useModel = model || this.defaultModel;

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
          model: useModel,
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
      if (!resp.ok) { console.warn(`OpenRouter error (${useModel}):`, resp.status); return null; }
      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content;
      return extractJSON(text);
    } catch (e) {
      if (e.name !== 'AbortError') console.warn(`AI error (${useModel}):`, e.message);
      return null;
    } finally {
      clearTimeout(to);
    }
  }
}
