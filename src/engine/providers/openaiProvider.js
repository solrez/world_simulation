// OpenAI provider. Behavior-identical to the previous inline callOpenAI:
// same endpoint, same json_object response format, same parsing and
// null-on-failure contract.

const DEFAULT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4.1-nano';

export class OpenAIProvider {
  constructor(config = {}) {
    this.apiKey = config.apiKey || import.meta.env.VITE_OPENAI_API_KEY;
    this.url = config.url || DEFAULT_URL;
    this.model = config.model || import.meta.env.VITE_OPENAI_MODEL || DEFAULT_MODEL;
  }

  // schema is accepted for interface parity; OpenAI's json_object mode does not
  // consume it directly, so it remains advisory (documented by the prompt).
  async complete({ system, user, temperature = 0.9, maxTokens = 500, signal }) {
    if (!this.apiKey) return null;
    try {
      const resp = await fetch(this.url, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature, max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        }),
      });
      if (!resp.ok) { console.warn('OpenAI API error:', resp.status, await resp.text()); return null; }
      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) return null;
      return JSON.parse(text);
    } catch (e) { console.warn('AI error:', e); return null; }
  }
}
