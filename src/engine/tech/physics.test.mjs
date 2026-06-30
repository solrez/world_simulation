// Standalone tests for the physics gate (Phase 1). No framework — run with:
//   node src/engine/tech/physics.test.mjs
// Exits non-zero on first failure. Uses hand-written hypotheses ONLY (no LLM), so
// a failure here is a bug in physics, never in a model.

import { physicsGate, comboKey, resolveInputs } from './physics.js';
import { buildMaterialCatalog } from '../../utils/constants.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error(`✗ ${name}`); }
}

// A person who knows fire, owns/has-noticed the common materials.
const baseState = () => ({
  materialCatalog: buildMaterialCatalog(),
  knownTech: { fire_knowledge: { by: 'test', day: 1 } },
});
const richPerson = () => ({
  knownTech: { fire_knowledge: true },
  inventory: { wood: 5, clay: 5, copper: 5, charcoal: 5, flint: 5, stone: 5 },
  noticedResources: {},
});

// — law 1: unknown process rejected —
check('unknown process rejected', !physicsGate(
  { inputs: ['clay'], process: 'assemble' }, baseState(), richPerson()).ok);

// — valid: fire a clay pot —
{
  const r = physicsGate({ inputs: ['clay'], process: 'heat' }, baseState(), richPerson());
  check('heat clay is valid', r.ok);
  check('valid result carries difficulty', r.ok && r.normalized.difficulty.attemptsNeeded >= 2);
  check('valid result carries dedup key', r.ok && r.normalized.key === comboKey(['clay'], 'heat'));
}

// — law 2: unknown material rejected (can't conserve mystery mass) —
check('unknown material rejected', !physicsGate(
  { inputs: ['moonstone'], process: 'grind' }, baseState(), richPerson()).ok);

// — law 2: too many inputs rejected —
check('too many inputs rejected', !physicsGate(
  { inputs: ['wood', 'clay', 'copper', 'charcoal', 'flint'], process: 'mix' }, baseState(), richPerson()).ok);

// — law 3: process enabler required (heat needs fire) —
{
  const noFire = { knownTech: {}, inventory: { clay: 5 }, noticedResources: {} };
  const r = physicsGate({ inputs: ['clay'], process: 'heat' }, { materialCatalog: buildMaterialCatalog(), knownTech: {} }, noFire);
  check('heat without fire rejected', !r.ok);
  // but a process with no enabler is fine without fire
  check('grind without fire ok', physicsGate({ inputs: ['clay'], process: 'grind' }, { materialCatalog: buildMaterialCatalog(), knownTech: {} }, noFire).ok);
}

// — law 4: must have access to inputs (owned or noticed) —
{
  const poor = { knownTech: { fire_knowledge: true }, inventory: {}, noticedResources: {} };
  check('no access to material rejected', !physicsGate(
    { inputs: ['clay'], process: 'heat' }, baseState(), poor).ok);
  // noticed-but-unowned still counts as access
  const noticed = { knownTech: { fire_knowledge: true }, inventory: {}, noticedResources: { clay: { day: 1 } } };
  check('noticed material grants access', physicsGate(
    { inputs: ['clay'], process: 'heat' }, baseState(), noticed).ok);
}

// — name resolution: plain-language → material id via tags/label —
{
  const cat = buildMaterialCatalog();
  check('resolves by tag (green metal -> copper via "metal")', resolveInputs(['the heavy metal rocks'], cat).ids.includes('copper'));
  check('resolves by label', resolveInputs(['Charcoal'], cat).ids.includes('charcoal'));
  check('dedups repeated inputs', resolveInputs(['wood', 'wood'], cat).ids.length === 1);
}

// — difficulty monotonicity: rarer input is harder than common —
{
  const easy = physicsGate({ inputs: ['wood'], process: 'dry' }, baseState(), richPerson());
  const hard = physicsGate({ inputs: ['copper', 'charcoal'], process: 'heat' }, baseState(), richPerson());
  check('rarer/complex combo is harder', easy.ok && hard.ok &&
    hard.normalized.difficulty.failureChance > easy.normalized.difficulty.failureChance);
}

// — determinism: same hypothesis → same difficulty + key —
{
  const a = physicsGate({ inputs: ['clay'], process: 'heat' }, baseState(), richPerson());
  const b = physicsGate({ inputs: ['clay'], process: 'heat' }, baseState(), richPerson());
  check('gate is deterministic', a.ok && b.ok &&
    a.normalized.key === b.normalized.key &&
    a.normalized.difficulty.failureChance === b.normalized.difficulty.failureChance);
}

console.log(`\nphysics gate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
