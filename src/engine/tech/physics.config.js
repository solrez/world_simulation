// ── Physics config (Phase 1) — data only, no logic ──
//
// The "laws" the gate enforces. Kept as plain data so the rules are auditable at
// a glance and tunable without touching gate logic. The gate (physics.js) reads
// these; nothing here imports anything.

// Allowed process verbs. An idea whose process isn't one of these is rejected
// outright — this is what keeps the world primitive (no "assemble circuit").
// Each entry carries the cost/effect of applying that process, used by both the
// difficulty estimate and (later) deterministic material derivation.
//
//   energyCost  — effort the process itself adds (on top of input energy)
//   complexity  — 0..1, how hard the process is to get right (drives failure)
//   enabler     — tech id that must be known before this process is usable
//                 (null = innate, anyone can try it)
//   addsTags    — tags the process imparts to its output material
//   removesTags — tags it strips (e.g. heating removes 'raw')
//   hardens     — multiplier on output durability (>1 hardens, <1 softens)
export const PROCESSES = {
  heat:    { energyCost: 1.5, complexity: 0.6, enabler: 'fire_knowledge', addsTags: ['fired'],  removesTags: ['raw', 'soft', 'wet'], hardens: 1.3 },
  grind:   { energyCost: 0.8, complexity: 0.3, enabler: null,             addsTags: ['ground'], removesTags: [],       hardens: 0.8 },
  mix:     { energyCost: 0.5, complexity: 0.4, enabler: null,             addsTags: ['mixed'],  removesTags: [],       hardens: 1.0 },
  dry:     { energyCost: 0.3, complexity: 0.2, enabler: null,             addsTags: ['dried'],  removesTags: ['wet'],  hardens: 1.1 },
  soak:    { energyCost: 0.3, complexity: 0.3, enabler: null,             addsTags: ['wet', 'soft'], removesTags: ['dried'], hardens: 0.7 },
  strike:  { energyCost: 0.6, complexity: 0.4, enabler: null,             addsTags: ['shaped'], removesTags: [],       hardens: 1.0 },
  bury:    { energyCost: 0.4, complexity: 0.3, enabler: null,             addsTags: ['cured'],  removesTags: [],       hardens: 1.0 },
  ferment: { energyCost: 0.5, complexity: 0.7, enabler: null,             addsTags: ['fermented'], removesTags: ['raw'], hardens: 0.9 },
  carve:   { energyCost: 0.7, complexity: 0.5, enabler: null,             addsTags: ['shaped', 'worked'], removesTags: [], hardens: 1.0 },
  weave:   { energyCost: 0.6, complexity: 0.5, enabler: null,             addsTags: ['woven', 'worked'],  removesTags: [], hardens: 1.0 },
};

// Materials so common they're always within reach (gathered freely at the Grove /
// Rock Seat / Meadow), not hidden discoveries. An idea using these isn't blocked
// for "not having" them — the agent can just go get them. Without this the gate
// rejects sensible ideas like "strike flint against a stone".
export const BASE_ACCESSIBLE = new Set(['wood', 'stone', 'thatch']);

export const GATE = {
  // Conservation: output mass may not exceed input mass by more than this slack
  // (a little slack absorbs rounding / "the process adds a bit of air"). No free
  // matter — you can't get more stuff out than you put in.
  MASS_SLACK: 0.15,
  MIN_INPUTS: 1,            // an idea must consume at least one material
  MAX_INPUTS: 4,            // beyond this it's not a primitive experiment

  // Difficulty curve (output of the gate, NOT authored by the LLM). The gate maps
  // input rarity + process complexity onto these so strong/rare combos are HARD,
  // not rejected. Tuned to sit in the same range as hand-authored TECH_GRAPH nodes
  // (attemptsNeeded 2..5, failureChance 0.25..0.55).
  BASE_ATTEMPTS: 2,
  MAX_ATTEMPTS: 6,
  BASE_FAIL: 0.30,
  MAX_FAIL: 0.75,
  MIN_FAIL: 0.20,
};
