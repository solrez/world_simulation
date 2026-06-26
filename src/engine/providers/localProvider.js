// Local provider — makes no network calls and returns null for every request.
//
// This turns "no LLM" into a first-class, swappable mode: the sim falls back
// entirely to its deterministic reflex + schedule behavior. Useful for offline
// runs, tests, and as the safe default when no API key is configured.

export class LocalProvider {
  // eslint-disable-next-line no-unused-vars
  async complete(_request) {
    return null;
  }
}
