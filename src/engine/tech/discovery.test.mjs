// Integration test for the discovery hinge (Phase 3). Run with:
//   node src/engine/tech/discovery.test.mjs
// Drives the gate -> mint chain against a REAL createSimulation() state, using the
// actual resource-node `look` text an agent would have stored — proving a novel,
// never-hardcoded idea becomes a registered recipe + material. No LLM/network.

import { createSimulation } from '../simulation.js';
import { physicsGate } from './physics.js';
import { mintRecipe } from './derive.js';
import { RESOURCE_NODES } from '../../utils/constants.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.error(`✗ ${name}`); }
}

const clayLook = RESOURCE_NODES.find(n => n.material === 'clay').look;

const s = createSimulation();
const p = s.people[0];
p.knownTech = { fire_knowledge: true };
p.inventory = { ...(p.inventory || {}), clay: 3 };
p.noticedResources = { clay: { near: 'Pond', look: clayLook, day: 1 } };

// the agent describes the material by its appearance, not its catalog name
const verdict = physicsGate({ inputs: ['the grey sticky earth'], process: 'heat' }, s, p);
check('agent look-text resolves to clay (gate passes)', verdict.ok);
check('combo key is resolved-id based', verdict.ok && verdict.normalized.key === 'clay::heat');

const recipe = mintRecipe(verdict.normalized, s, { label: 'clay pot' });
check('novel recipe minted', !!recipe);
check('recipe registered for prototype lookup', !!recipe && s.recipeCatalog[recipe.id] === recipe);
check('novel material registered', !!s.materialCatalog['d_heat_clay']);
check('effect is within applyTechEffect switch',
  !!recipe && ['tool', 'material', 'storage', 'farmYield', 'enable'].includes(recipe.effect.type));
check('difficulty within authored range',
  !!recipe && recipe.attemptsNeeded >= 2 && recipe.attemptsNeeded <= 6 &&
  recipe.failureChance >= 0.2 && recipe.failureChance <= 0.75);

// a physically impossible idea is rejected and does NOT mint anything
const recipeCountBefore = Object.keys(s.recipeCatalog).length;
const bad = physicsGate({ inputs: ['the moonstone'], process: 'assemble' }, s, p);
check('impossible idea rejected', !bad.ok);
check('rejected idea mints nothing', Object.keys(s.recipeCatalog).length === recipeCountBefore);

console.log(`\ndiscovery hinge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
