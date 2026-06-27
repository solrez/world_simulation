// Provider abstraction — one swappable interface for all LLM calls.
//
// Every provider exposes a single method:
//   complete({ system, user, schema, temperature, maxTokens, label }) -> Promise<object|null>
//
// It returns a parsed JS object, or null on any failure (network, bad JSON,
// missing key). Every caller already treats null as "no decision this tick",
// so a provider that always returns null degrades the sim gracefully to its
// local reflex + schedule behavior.
//
// The active provider is selected by VITE_AI_PROVIDER ('openrouter' | 'openai'
// | 'local'). Per-agent models (passed as `model` on each complete() call) are
// supported by the OpenRouter provider; others ignore it and use their default.

import { OpenAIProvider } from './openaiProvider.js';
import { OpenRouterProvider } from './openrouterProvider.js';
import { LocalProvider } from './localProvider.js';

let _provider = null;

export function getProvider() {
  if (_provider) return _provider;
  _provider = createProvider();
  return _provider;
}

// Exposed mainly for tests / runtime reconfiguration.
export function createProvider(config = {}) {
  const name = config.provider || import.meta.env.VITE_AI_PROVIDER || 'openrouter';
  switch (name) {
    case 'local':
      return new LocalProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'openrouter':
    default:
      return new OpenRouterProvider(config);
  }
}
