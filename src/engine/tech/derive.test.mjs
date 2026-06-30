// Standalone tests for dynamic registration (Phase 2). Run with:
//   node src/engine/tech/derive.test.mjs
// Hand-written inputs only — no LLM. A failure here is a derivation/registration
// bug. Asserts the two make-or-break properties: determinism and no-drift.

import { deriveMaterial, deriveEffect, mintRecipe, derivedMaterialId } from './derive.js';
import { physicsGate } from './physics.js';
import { buildMaterialCatalog } from '../../utils/constants.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.error(`✗ ${name}`); }
}

const newState = () => ({
  schemaVersion: 1,
  materialCatalog: buildMaterialCatalog(),
  recipeCatalog: {},
  knownTech: { fire_knowledge: { by: 't', day: 1 } },
});

// — deriveMaterial: deterministic & conserves mass —
{
  const s = newState();
  const m = deriveMaterial(['clay'], 'heat', s);
  check('derives a material from clay+heat', !!m && m.id === derivedMaterialId(['clay'], 'heat'));
  check('heat removes "raw" tag', !m.tags.includes('raw'));
  check('heat adds "fired" tag', m.tags.includes('fired'));
  check('worked tag always present', m.tags.includes('worked'));

  const clayMass = s.materialCatalog.clay.mass;
  check('output mass does not exceed input mass (conservation)', m.mass <= clayMass + 0.001);

  const clayDur = s.materialCatalog.clay.durability;
  check('heat hardens (durability up vs raw clay)', m.durability > clayDur);

  // determinism: same inputs+process → identical numbers
  const m2 = deriveMaterial(['clay'], 'heat', newState());
  check('deriveMaterial is deterministic', m.id === m2.id && m.durability === m2.durability &&
    m.mass === m2.mass && m.energyCost === m2.energyCost && m.rarity === m2.rarity);
}

// — multi-input conservation: combined mass, reduced by burn-off, never grows —
{
  const s = newState();
  const m = deriveMaterial(['copper', 'charcoal'], 'heat', s);
  const inMass = s.materialCatalog.copper.mass + s.materialCatalog.charcoal.mass;
  check('multi-input output mass <= input mass', m.mass <= inMass + 0.001);
  check('multi-input rarity >= rarest input', m.rarity >= Math.max(s.materialCatalog.copper.rarity, s.materialCatalog.charcoal.rarity) - 0.001);
}

// — deriveEffect: bounded magnitudes (power-gate) —
{
  const s = newState();
  const fired = deriveMaterial(['clay'], 'heat', s);
  fired.label = 'Fired Clay';
  const eff = deriveEffect(fired);
  check('fired durable vessel -> storage effect', eff.type === 'storage');
  check('storage effect capped under smokehouse (<=0.45)', eff.food <= 0.45);

  const ground = deriveMaterial(['stone'], 'grind', s);
  const eff2 = deriveEffect(ground);
  check('ground earthy -> farmYield', eff2.type === 'farmYield');
  check('farmYield capped under plow (<=1.4)', eff2.mult <= 1.4);
}

// — mintRecipe: registers recipe + material, idempotent, TECH_GRAPH-shaped —
{
  const s = newState();
  const r = physicsGate({ inputs: ['clay'], process: 'heat' }, s,
    { knownTech: { fire_knowledge: true }, inventory: { clay: 3 }, noticedResources: {} });
  check('gate passes the seed hypothesis', r.ok);

  const recipe = mintRecipe(r.normalized, s, { label: 'Fired Clay' });
  check('recipe minted', !!recipe);
  check('recipe has TECH_GRAPH shape', recipe.id && recipe.label &&
    Array.isArray(recipe.prereqMaterials) && recipe.effect && typeof recipe.failureChance === 'number');
  check('recipe registered in catalog', s.recipeCatalog[recipe.id] === recipe);
  check('output material registered', !!s.materialCatalog[derivedMaterialId(['clay'], 'heat')]);
  check('heat recipe carries fire prereq', recipe.prereqKnowledge.includes('fire_knowledge'));
  check('recipe difficulty came from the gate', recipe.attemptsNeeded === r.normalized.difficulty.attemptsNeeded);

  // idempotency: re-mint same combo → same recipe, no twin material
  const matCountBefore = Object.keys(s.materialCatalog).length;
  const recipeCountBefore = Object.keys(s.recipeCatalog).length;
  const again = mintRecipe(r.normalized, s, { label: 'Fired Clay' });
  check('re-mint returns same recipe (no twin)', again.id === recipe.id);
  check('no new material on re-mint', Object.keys(s.materialCatalog).length === matCountBefore);
  check('no new recipe on re-mint', Object.keys(s.recipeCatalog).length === recipeCountBefore);

  // re-discovery via different naming should find the same recipe by match hints
  check('match hints include process + input', recipe.matches.includes('heat') && recipe.matches.includes('clay'));
}

console.log(`\nderive/registration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
