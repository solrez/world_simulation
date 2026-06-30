// ── Dynamic registration (Phase 2) ──
//
// Turns a gate-approved hypothesis into real, registered game data. The LLM
// contributes ONLY names (a label, maybe a flavor word); every NUMBER and
// PROPERTY here is COMPUTED from inputs + process. This is the rule that keeps
// the catalog from drifting and power from running away.
//
//   deriveMaterial(inputs, process, state) -> material entry (deterministic)
//   deriveEffect(material)                 -> { type, ... } within applyTechEffect's switch
//   mintRecipe(normalized, state, opts)    -> recipe node in TECH_GRAPH shape, registered
//
// Nothing here calls an LLM. mintRecipe MUTATES state (registers into the runtime
// catalogs) — that's its whole job; the gate stays pure, registration is the
// effect.

import { PROCESSES, GATE } from './physics.config.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = (v) => Math.round(v * 100) / 100;

// Canonical id for a derived material: deterministic from inputs+process, so the
// SAME experiment always maps to the SAME material (no "fired clay" twins). This
// is the dedup key that closes the drift door.
export function derivedMaterialId(inputs, process) {
  return `d_${process}_${[...inputs].sort().join('_')}`;
}

// Derive a new material's PROPERTIES from its inputs and the process applied.
// Pure & deterministic. Tags/durability/energy/rarity all flow from the inputs
// transformed by the process — never from free text.
export function deriveMaterial(inputs, process, state) {
  const cat = state.materialCatalog;
  const proc = PROCESSES[process] || {};
  const mats = inputs.map(id => cat[id]).filter(Boolean);
  if (!mats.length) return null;

  const id = derivedMaterialId(inputs, process);
  // already discovered before — return the canonical entry, don't re-mint
  if (cat[id]) return cat[id];

  const sum = (f) => mats.reduce((s, m) => s + (m[f] ?? 0), 0);
  const avg = (f, dflt) => mats.length ? sum(f) / mats.length : dflt;

  // mass: conserved — output is the combined input mass, lightly reduced by
  // processes that drive material off (heat/dry/ferment burn some away).
  const massLoss = (proc.removesTags || []).includes('raw') ? 0.85 : 1;
  const mass = round2(Math.max(0.3, sum('mass') * massLoss));

  // durability: average input durability, hardened/softened by the process,
  // capped at 1. A fired/worked thing is sturdier than its raw inputs.
  const durability = round2(clamp(avg('durability', 0.5) * (proc.hardens ?? 1), 0.05, 1));

  // energy: it cost the inputs' energy PLUS the process effort. Worked things are
  // "expensive" — this feeds difficulty and value of anything made FROM them.
  const energyCost = round2(sum('energyCost') + (proc.energyCost ?? 0.5));

  // rarity: a worked material is at least as rare as its rarest input (you can
  // only have it if you had them), nudged up by process effort.
  const rarity = round2(clamp(Math.max(...mats.map(m => m.rarity ?? 0.3)) + (proc.complexity ?? 0) * 0.15, 0, 1));

  // tags: union of input tags, plus what the process imparts, minus what it
  // strips. De-duped. This is how "raw clay" + heat becomes "fired".
  const inTags = new Set(mats.flatMap(m => m.tags || []));
  for (const t of proc.removesTags || []) inTags.delete(t);
  for (const t of proc.addsTags || []) inTags.add(t);
  inTags.add('worked'); // anything you made is, by definition, worked
  const tags = [...inTags];

  return {
    id, label: null, // label filled by mintRecipe (LLM flavor or a derived default)
    tags, origin: 'derived',
    mass, durability, energyCost, rarity,
    derivedFrom: { inputs: [...inputs].sort(), process },
    version: state.schemaVersion || 1,
  };
}

// Map a derived material + process onto a CONCRETE game effect, bounded by what
// applyTechEffect already understands. We deliberately target the data-driven
// effect types (storage / farmYield / material) — a dynamically-NAMED tool would
// be inert because tool boosts are read by hardcoded name in the harvest paths,
// so we don't pretend to mint tools here.
//
// Magnitudes are derived from material properties and CAPPED (the power-gate):
// stronger effects require costlier/sturdier outputs, with diminishing returns.
export function deriveEffect(material) {
  const tags = new Set(material.tags || []);

  // a fired vessel (or tight-woven basket) preserves food → storage (cuts
  // spoilage). The sturdier it is, the more it helps — but capped well under a
  // smokehouse (0.6). Threshold sits just below fired clay so ceramics, the
  // canonical first storage tech, qualify.
  if ((tags.has('fired') || tags.has('woven')) && material.durability >= 0.25) {
    const food = clamp(round2(0.15 + material.durability * 0.25), 0.1, 0.45);
    return { type: 'storage', food };
  }

  // a worked, soil-friendly thing (ground/mixed earthy stuff) → farm yield bump,
  // capped modestly so it can't out-leap the authored plow (1.6).
  if ((tags.has('ground') || tags.has('mixed') || tags.has('cured')) && !tags.has('metal')) {
    const mult = clamp(round2(1 + material.durability * 0.3 + 0.1), 1.05, 1.4);
    return { type: 'farmYield', mult };
  }

  // default: the experiment yields a useful new MATERIAL (a building block for
  // future, harder recipes). This is the common, safe outcome — it grows the
  // tech tree's BREADTH without directly buffing the village. Power comes only
  // when a later recipe turns these into storage/yield.
  return { type: 'material', material: material.id };
}

// Build a recipe node in the EXACT TECH_GRAPH shape and REGISTER it (plus any new
// material) into the runtime catalogs on state. Returns the recipe node. Idempotent
// per combo: re-minting the same inputs+process returns the existing recipe.
export function mintRecipe(normalized, state, opts = {}) {
  const { inputs, process, difficulty, key } = normalized;

  // already a recipe for this combo? return it (re-discovery, not a twin).
  const existing = Object.values(state.recipeCatalog || {})
    .find(r => r._mintedKey === key);
  if (existing) return existing;

  // derive (or fetch) the output material and register it.
  const material = deriveMaterial(inputs, process, state);
  if (!material) return null;
  if (!state.materialCatalog[material.id]) {
    // the MATERIAL gets a clean, derived name (verb + base material) — never the
    // agent's verbose phrase, which stacks badly ("Dried Digging edge").
    material.label = defaultMaterialLabel(inputs, process, state);
    state.materialCatalog[material.id] = material;
  }
  const mat = state.materialCatalog[material.id];

  const effect = deriveEffect(mat);

  const id = `d_${key.replace(/[^a-z0-9]+/gi, '_')}`;
  // the RECIPE label prefers the agent's own name for what they're making (a
  // noun phrase like "a digging edge"); fall back to the derived material name.
  const label = opts.recipeLabel || opts.label || mat.label;
  const recipe = {
    id, label,
    prereqMaterials: [...inputs],
    prereqKnowledge: prereqKnowledgeFor(process),
    attemptsNeeded: difficulty.attemptsNeeded,
    failureChance: difficulty.failureChance,
    effect,
    role: null,
    group: false,
    // keyword hints so OTHERS can re-discover this via the existing matcher.
    matches: matchHintsFor(inputs, process, mat, state),
    origin: 'derived',
    _mintedKey: key,
  };
  state.recipeCatalog[id] = recipe;
  return recipe;
}

// The process's enabler (if any) is a knowledge prereq for the recipe.
function prereqKnowledgeFor(process) {
  const en = PROCESSES[process]?.enabler;
  return en ? [en] : [];
}

function verbLabel(process) {
  const map = { heat: 'Fired', grind: 'Ground', mix: 'Mixed', dry: 'Dried', soak: 'Soaked',
    strike: 'Struck', bury: 'Cured', ferment: 'Fermented', carve: 'Carved', weave: 'Woven' };
  return map[process] || 'Worked';
}

function defaultMaterialLabel(inputs, process, state) {
  const first = state.materialCatalog[inputs[0]]?.label || inputs[0];
  return `${verbLabel(process)} ${first}`;
}

// Keyword hints for the free-text idea matcher, drawn from the real inputs,
// process synonyms, and the output's labels/tags — so a second villager phrasing
// the same idea differently still maps onto this recipe.
function matchHintsFor(inputs, process, mat, state) {
  const hints = new Set([process]);
  for (const id of inputs) {
    hints.add(id);
    const label = state.materialCatalog[id]?.label;
    if (label) hints.add(label.toLowerCase());
  }
  if (mat.label) hints.add(mat.label.toLowerCase());
  for (const t of mat.tags || []) hints.add(t);
  return [...hints];
}

export { GATE as DERIVE_GATE };
