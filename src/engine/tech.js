// ════════════════════════════════════════════════════════════════════════════
// INVENTION & TECH  (Phases 1-5, 7)
//
// The agents never see the tech graph. They notice raw materials they're near,
// the LLM ideates freely from what they've personally seen, and the SYSTEM maps
// that idea onto the hidden DAG, validates prerequisites, and runs a multi-tick
// prototyping loop where failure is productive. Knowledge then spreads by
// observation and teaching, and dies with its holder unless it was passed on.
// ════════════════════════════════════════════════════════════════════════════

import { GATE, DISCOVERY, LIFE_STAGES, PROTOTYPE, IDEA } from '../utils/constants.js';
import { perceive } from './vision.js';
import { generateIdeation } from './ai.js';
import { physicsGate } from './tech/physics.js';
import { mintRecipe } from './tech/derive.js';
import { simlog } from './log.js';
import { recordAttempt, recordGate, recordMint, recordBreakthroughMetric } from './tech/metrics.js';
import { distBetween, clamp, setGoal, goToPerson } from './movement.js';
import { addMemory, setEmote } from './memory.js';
import { totalFood } from './food.js';
import { bumpReputation } from './reputation.js';
import { rewardAction } from './q.js';
import { gainSkill } from './skills.js';
import { recipeFor, allRecipes } from './catalog.js';
import { recordModelResult } from './models.js';

// Does this person have a "pressing need" sharp enough to make them inventive?
// Frustration is the mother of invention: a tired builder eyeing hard rocks, a
// hungry farmer wishing the soil turned easier. Returns a short phrase or null.
export function pressingNeed(person, state) {
  if (person.hunger > GATE.HUNGER_BAND[0]) return 'always hungry — gathering food by hand is exhausting';
  if (person.tiredness > GATE.TIRED_BAND[0] && (person.activity === 'chopping' || person.activity === 'building'))
    return 'sick of hacking at wood and stone with crude tools';
  if (person.buildProject && person.buildProject.phase !== 'complete')
    return 'this build is dragging — there must be a better way';
  if (totalFood(state) < 25) return 'the village stores keep running low — food spoils too fast';
  if ((person.skills?.farming || 0) > 10 && state.field?.planted)
    return 'tilling the field by hand is back-breaking work';
  return null;
}

// How observant is this person right now, as a multiplier on a node's base
// notice chance — trait + relevant skill + need + darkness.
function discoveryAcuity(person, node, state, needy) {
  let m = 1;
  if (person.traits?.includes('curious') || person.traits?.includes('observant')) m *= DISCOVERY.CURIOSITY_MULT;
  if (person.traits?.includes('creative')) m *= DISCOVERY.CREATIVITY_MULT;
  const skill = Math.max(...(node.noticedBy || []).map(s => person.skills?.[s] || 0), 0);
  m *= 1 + (skill / 10) * DISCOVERY.SKILL_MULT_PER_10;
  if (needy) m *= DISCOVERY.NEED_MULT;
  if (state.timeOfDay === 'night') m *= DISCOVERY.NIGHT_MULT;
  return m;
}

// Phase 1 — each tick, if this person is near an undiscovered node and the dice
// (scaled by acuity) land, they NOTICE it: a personal discovery memory is seeded
// and the material becomes raw fuel for ideation. Runs cheaply per agent per tick.
export function processDiscovery(person, state) {
  if (person.sleeping || person.eating || person.lifeStage === LIFE_STAGES.BABY) return;
  const needy = !!pressingNeed(person, state);
  for (const node of state.resourceNodes || []) {
    if (person.noticedResources?.[node.material]) continue; // already known to them
    const d = Math.hypot(person.x - node.x, person.y - node.y);
    if (d > DISCOVERY.RANGE) continue;
    const chance = node.base * discoveryAcuity(person, node, state, needy) * (DISCOVERY.RATE_MULT || 1);
    if (Math.random() < chance) {
      person.noticedResources[node.material] = { near: node.near, look: node.look, day: state.day };
      node.discoveredBy[person.name] = true; // map reveals it once anyone's seen it
      addMemory(person, `Noticed ${node.look} near ${node.near}.`, 'discovery', state.day,
        { location: node.near, valence: 1 });
      person.thought = `Strange... ${node.look}.`;
      simlog('resource.noticed', { person: person.name, day: state.day, material: node.material,
        near: node.near }, `${person.name} noticed ${node.material} near ${node.near}`);
      setEmote(person, 'sparkle', 14);
    }
  }
}

// ── Tech graph helpers ──

// Whether a tech's prerequisites are met for THIS person right now. Returns
// { ok, missingMaterials, missingKnowledge } so the caller can turn the first
// gap into the agent's next goal (Phase 2).
function techPrereqsMet(person, state, tech) {
  const missingMaterials = (tech.prereqMaterials || []).filter(mat => {
    if ((person.inventory?.[mat] || 0) > 0) return false;
    // a noticed-but-unmined material still counts as "known to exist"; mining
    // it is the goal. But producible materials (charcoal, ingot) must be owned.
    if (person.noticedResources?.[mat]) return false;
    return true;
  });
  const missingKnowledge = (tech.prereqKnowledge || []).filter(k =>
    !(person.knownTech?.[k] || state.knownTech?.[k]));
  return { ok: missingMaterials.length === 0 && missingKnowledge.length === 0, missingMaterials, missingKnowledge };
}

// Map a free-text LLM idea onto a tech node, honoring what the person could
// plausibly be reaching for. Returns the node or null (silent rejection).
function matchIdeaToTech(ideaText, state) {
  if (!ideaText) return null;
  const t = ideaText.toLowerCase();
  let best = null, bestHits = 0;
  for (const tech of allRecipes(state)) {
    const hits = (tech.matches || []).filter(kw => t.includes(kw)).length;
    if (hits > bestHits) { bestHits = hits; best = tech; }
  }
  return bestHits > 0 ? best : null;
}

// Techs this person could ATTEMPT next: prereqs met, not already known. Used to
// nudge a matched idea toward something reachable, and to seed prototypes.
export function attemptableTech(person, state, tech) {
  if (!tech) return false;
  if (person.knownTech?.[tech.id]) return false;
  return techPrereqsMet(person, state, tech).ok;
}

// Begin (or refuse) a prototype from a matched tech. If prereqs are unmet, the
// first missing piece becomes a goal and we return a "blocked" flavor instead.
function beginPrototype(person, state, tech) {
  const { ok, missingMaterials, missingKnowledge } = techPrereqsMet(person, state, tech);
  if (!ok) {
    // turn the gap into the agent's next pursuit (Phase 2: missing piece = goal)
    if (missingKnowledge.length) {
      const need = recipeFor(state, missingKnowledge[0]);
      person.thought = `I can't make this yet — I need to figure out ${need?.label || missingKnowledge[0]} first.`;
    } else if (missingMaterials.length) {
      const mat = missingMaterials[0];
      person.thought = `I'd need ${mat} for this. Where would I even find ${mat}?`;
      // point them at the node if it exists, so the search is real
      const node = (state.resourceNodes || []).find(n => n.material === mat);
      if (node) { person.targetX = node.x; person.targetY = node.y; setGoal(person, 'seek_material', mat, 120); }
    }
    return false;
  }
  person.prototype = {
    techId: tech.id, label: tech.label, progress: 0,
    attemptsLeft: tech.attemptsNeeded, failureChance: tech.failureChance,
    group: !!tech.group, // a big dig/build that wants a second pair of hands (Phase 7)
  };
  person.activity = 'experimenting';
  setGoal(person, 'prototype', tech.label, 300);
  simlog('discovery.prototype', { person: person.name, day: state.day, recipe: tech.id,
    label: tech.label, attempts: tech.attemptsNeeded }, `${person.name} began prototyping ${tech.label}`);
  if (tech.group) {
    person.thought = `This is too much for one person — I should get someone to help dig.`;
    // recruit: seek the friendliest available adult to lend a hand
    const helper = recruitHelper(person, state);
    if (helper) goToPerson(person, helper); // walk to them; proximity drives the group bonus
  } else {
    person.thought = `Going to try something with the ${(tech.prereqMaterials || []).join(' and ')}...`;
  }
  setEmote(person, 'sparkle', 16);
  return true;
}

// Phase 7 — find a nearby-ish willing adult to help on a group project. Prefers
// a friend/partner; returns null if nobody suitable.
function recruitHelper(person, state) {
  let best = null, bestScore = 20;
  for (const o of state.people) {
    if (o === person || o.alive === false || o.lifeStage === LIFE_STAGES.BABY || o.lifeStage === LIFE_STAGES.CHILD) continue;
    if (o.prototype || o.buildProject) continue; // already busy inventing/building
    const rel = person.relationships?.[o.name];
    const score = (rel?.affection || 0) + (person.partner === o.name ? 40 : 0);
    if (score > bestScore) { bestScore = score; best = o; }
  }
  return best;
}

// Phase 4 — advance an in-progress prototype one tick. Fills a progress bar;
// each completed bar is one ATTEMPT that may fail (consuming material, teaching
// a little) or succeed (breakthrough). Failure is productive.
export function processPrototype(person, state) {
  const proto = person.prototype;
  if (!proto) return;
  const tech = recipeFor(state, proto.techId);
  if (!tech) { person.prototype = null; return; }
  person.activity = 'experimenting';

  const skill = Math.max(person.skills?.crafting || 0, person.skills?.building || 0);
  const toolMult = person.tools?.copper_axe || person.tools?.flint_knife ? 1.3 : 1;
  // Phase 7: a group project (e.g. irrigation ditch) crawls alone and speeds up
  // with a willing pair of hands nearby. Check for a helper within reach.
  let groupMult = 1;
  if (proto.group) {
    const helper = state.people.find(o => o !== person && o.alive !== false &&
      o.lifeStage !== LIFE_STAGES.BABY && o.lifeStage !== LIFE_STAGES.CHILD &&
      distBetween(person, o) <= 3);
    if (helper) {
      groupMult = 2.2;
      if (Math.random() < 0.01) {
        helper.thought = `Helping ${person.name} dig.`;
        const hr = helper.relationships?.[person.name];
        if (hr) hr.affection = clamp(hr.affection + 0.5, 0, 100);
      }
    } else {
      groupMult = 0.25; // barely makes headway solo — they really need help
      if (Math.random() < 0.02) person.thought = `I can't do this alone — I need help.`;
    }
  }
  proto.progress += (PROTOTYPE.PROGRESS_PER_TICK + (skill / 10) * PROTOTYPE.SKILL_PROGRESS_PER_10) * toolMult * groupMult;
  if (proto.progress < 1) {
    if (Math.random() < 0.03) person.thought = `Fiddling with the ${(tech.prereqMaterials || [])[0] || 'materials'}...`;
    return;
  }
  // one full attempt resolved
  proto.progress = 0;
  proto.attemptsLeft = Math.max(0, proto.attemptsLeft - 1);
  const effFail = Math.max(0.05, proto.failureChance - (skill / 100));
  // once the planned attempts are used up, a try lands with prob (1 - effFail);
  // before then, a lucky early breakthrough is possible but rare (~15%).
  const succeed = proto.attemptsLeft <= 0 ? (Math.random() > effFail) : (Math.random() > 0.85);

  recordAttempt(state, succeed);
  if (!succeed) {
    // productive failure: burn a material, learn a little, leave a memory
    const mat = (tech.prereqMaterials || []).find(m => (person.inventory?.[m] || 0) > 0);
    if (mat) person.inventory[mat] = Math.max(0, person.inventory[mat] - PROTOTYPE.MATERIAL_COST_ON_FAIL);
    proto.failureChance = Math.max(0.05, proto.failureChance - PROTOTYPE.FAIL_LEARN_BONUS);
    if (proto.attemptsLeft <= 0) proto.attemptsLeft = 1; // not ready to land yet — keep trying
    const flavor = failureFlavor(tech);
    addMemory(person, flavor, 'experiment', state.day, { location: person.currentLocation, valence: -0.3 });
    person.thought = flavor;
    gainSkill(person, 'crafting', 0.1);
    setEmote(person, 'sweat', 10);
    rewardAction(person, 'invent', -0.5, state); // small sting, but they keep going
    simlog('discovery.fail', { person: person.name, day: state.day, recipe: tech.id,
      attemptsLeft: proto.attemptsLeft }, `${person.name} failed at ${tech.label}`);
    return;
  }
  techBreakthrough(person, state, tech);
}

function failureFlavor(tech) {
  switch (tech.id) {
    case 'copper_smelting': return 'Tried to melt the green rocks — nothing happened. Maybe the fire wasn\'t hot enough?';
    case 'clay_pottery': return 'The clay bowl cracked apart in the fire. Too fast, maybe.';
    case 'charcoal': return 'The wood just burned to ash, not the black stuff. I covered it wrong.';
    case 'fire_knowledge': return 'Couldn\'t get the fire to catch the way I wanted. Frustrating.';
    default: return `Tried to make ${tech.label.toLowerCase()} — it didn't work. Something's missing.`;
  }
}

// Phase 4/5 — a breakthrough. Permanent personal + village knowledge, big Q
// reward, reputation, role formalization, emote, chronicle entry.
function techBreakthrough(person, state, tech) {
  person.prototype = null;
  // already known to this person? don't re-celebrate a known craft — just clear
  // the prototype and move on. Prevents re-prototyping a recipe from re-firing a
  // full "breakthrough" (rewards, chronicle, logs) every time.
  if (person.knownTech[tech.id]) { person.activity = 'idle'; return; }
  person.knownTech[tech.id] = true;
  const firstForVillage = !state.knownTech[tech.id];
  if (firstForVillage) {
    state.knownTech[tech.id] = { by: person.name, day: state.day };
    state.inventions.push({ techId: tech.id, label: tech.label, by: person.name, day: state.day });
    state.events.push({ day: state.day, hour: state.hour, participants: [person.name],
      summary: `💡 ${person.name} invented ${tech.label}!`, type: 'invention' });
  }
  recordBreakthroughMetric(state, tech, tech.effect?.type);
  simlog('discovery.breakthrough', { person: person.name, day: state.day, recipe: tech.id,
    label: tech.label, effect: tech.effect, novel: tech.origin === 'derived', firstForVillage },
    `💡 ${person.name} ${firstForVillage ? 'INVENTED' : 'replicated'} ${tech.label}`);
  // apply the payoff
  applyTechEffect(person, state, tech);
  // formalize a role (Phase 7)
  if (tech.role && !person.techRole) {
    person.techRole = tech.role;
    addMemory(person, `Became the village's ${tech.role}.`, 'achievement', state.day, { valence: 2 });
  }
  addMemory(person, `Figured out how to make ${tech.label}! A real breakthrough.`, 'achievement', state.day,
    { location: person.currentLocation, valence: 2.5 });
  person.thought = `I did it — ${tech.label}!`;
  person.mood = 'excited';
  setEmote(person, 'sparkle', 40);
  bumpReputation(state, person.name, 'skilled', PROTOTYPE.REP_BREAKTHROUGH);
  rewardAction(person, 'invent', PROTOTYPE.REWARD_BREAKTHROUGH, state);
  gainSkill(person, 'crafting', 2);
  person.activity = 'idle';
}

// Translate a tech's `effect` into actual sim mechanics for this person/village.
function applyTechEffect(person, state, tech) {
  const e = tech.effect || {};
  switch (e.type) {
    case 'tool':
      person.tools = { ...(person.tools || {}), [e.tool]: true };
      break;
    case 'material':
      // smelting/charcoal turns a raw material into a worked one on success
      person.inventory[e.material] = (person.inventory[e.material] || 0) + 2;
      break;
    case 'storage':
      // pottery/drying/smokehouse cut village food spoilage — tracked on state
      state.spoilageMult = Math.min(state.spoilageMult ?? 1, 1 - (e.food || 0));
      break;
    case 'farmYield':
      // plow/irrigation boost field yields — read by the harvest path
      state.farmYieldMult = Math.max(state.farmYieldMult ?? 1, e.mult || 1);
      break;
    default:
      break; // 'enable' (fire_knowledge) is its own reward: unlocks downstream
  }
}

// Phase 5 — learning by observation. If this person SEES someone with a tech
// they lack actively using it (experimenting / smithing nearby), they may pick
// up the idea and attempt to replicate it. Cheap, vision-gated, rare.
export function processTechObservation(person, state) {
  if (person.sleeping || person.eating || person.prototype) return;
  if (Math.random() > 0.02) return; // observation is occasional, not constant
  const seen = perceive(person, state).people;
  for (const other of seen) {
    const theirTech = other.knownTech ? Object.keys(other.knownTech) : [];
    for (const techId of theirTech) {
      if (person.knownTech?.[techId]) continue;
      const tech = recipeFor(state, techId);
      if (!tech || !attemptableTech(person, state, tech)) continue;
      // only "click" if they're plausibly demonstrating it (working/experimenting)
      if (!['experimenting', 'crafting', 'building', 'farming'].includes(other.activity)) continue;
      addMemory(person, `Watched ${other.name} make ${tech.label} — I think I see how.`, 'discovery', state.day,
        { location: person.currentLocation, valence: 1 });
      person.thought = `So that's how ${other.name} does it...`;
      beginPrototype(person, state, tech);
      return;
    }
  }
}

// Phase 3 — the ideation escalation. When a needy, curious person who's noticed
// raw materials gets a chance, fire a constrained LLM call asking what they
// might try making. The system maps the idea onto the graph and prototypes it.
export async function runIdeation(gameRef, personIdx, signal) {
  const person = gameRef.current.people[personIdx];
  person.pendingIdea = false;
  const rate = DISCOVERY.RATE_MULT || 1;
  person.ideaCooldown = Math.round((IDEA.COOLDOWN_MIN + Math.floor(Math.random() * IDEA.COOLDOWN_SPAN)) / rate);
  if (person.prototype || person.sleeping || person.eating) return;
  const cs = gameRef.current;
  const need = pressingNeed(person, cs) || 'a nagging sense there must be a better way';
  const noticed = Object.values(person.noticedResources || {})
    .map(info => `${info.look} (near ${info.near})`);
  if (!noticed.length) return; // nothing to ideate from
  const knownTechniques = Object.keys(person.knownTech || {})
    .map(id => recipeFor(cs, id)?.label).filter(Boolean);
  simlog('ideation.fire', { person: person.name, day: cs.day, model: person.model,
    noticed: Object.keys(person.noticedResources || {}) }, `${person.name} is thinking up an idea...`);
  const result = await generateIdeation(person, { need, noticed, knownTechniques }, signal);
  recordModelResult(cs, person.model, !!result);
  if (!result || !result.idea) {
    simlog('ideation.empty', { person: person.name, day: cs.day, model: person.model },
      `${person.name}'s idea came back empty (model gave nothing usable)`);
    return;
  }
  person.thought = result.idea;
  simlog('ideation.result', { person: person.name, day: cs.day, idea: result.idea,
    making: result.making, inputs: result.inputs, process: result.process },
    `${person.name}: "${result.idea}"`);
  // 1) known recipe? prototype it (the original, cheap, deterministic path).
  const tech = matchIdeaToTech(result.idea + ' ' + (result.making || ''), cs);
  if (tech) { beginPrototype(person, cs, tech); return; }

  // 2) novel idea — try to DISCOVER something new. Run the LLM's structured
  // intent through the physics gate; if it's allowed, mint a real recipe (and
  // material) and prototype it. If the model gave no structured intent, fall
  // back to the old "it stews" behavior.
  const hypothesis = { inputs: result.inputs, process: result.process };
  if (Array.isArray(hypothesis.inputs) && hypothesis.process) {
    const verdict = physicsGate(hypothesis, cs, person);
    recordGate(cs, verdict.ok, verdict.reason);
    if (verdict.ok) {
      // skip a dead-end we've already proven impossible (dedup, cheap)
      if (cs.rejectedCombos?.[verdict.normalized.key]) { stewIdea(person, cs, result); return; }
      simlog('discovery.gate.pass', { person: person.name, day: cs.day, process: hypothesis.process,
        inputs: verdict.normalized.inputs }, `${person.name}: "${result.idea}"`);
      // was there already a recipe for this exact combo? (re-discovery, not new)
      const fresh = !Object.values(cs.recipeCatalog).some(r => r._mintedKey === verdict.normalized.key);
      const minted = mintRecipe(verdict.normalized, cs, { label: cleanLabel(result.making) });
      if (minted) {
        if (fresh) {
          recordMint(cs, minted, hypothesis.process, cs.day);
          simlog('discovery.mint', { person: person.name, day: cs.day, recipe: minted.id,
            label: minted.label, effect: minted.effect, attempts: minted.attemptsNeeded,
            fail: Math.round(minted.failureChance * 100) / 100 },
            `${person.name} conceived "${minted.label}"`);
        }
        person.thought = `${result.idea} — let me try.`;
        beginPrototype(person, cs, minted);
        return;
      }
    } else {
      // physically impossible — remember the dead-end so we don't re-propose it
      const key = `${[...new Set(hypothesis.inputs.map(s => String(s).toLowerCase()))].sort().join('+')}::${String(hypothesis.process).toLowerCase()}`;
      cs.rejectedCombos = cs.rejectedCombos || {};
      cs.rejectedCombos[key] = verdict.reason;
      simlog('discovery.gate.reject', { person: person.name, day: cs.day, process: hypothesis.process,
        inputs: hypothesis.inputs, reason: verdict.reason }, `${person.name}'s idea rejected: ${verdict.reason}`);
    }
  }
  stewIdea(person, cs, result);
}

// The "couldn't quite figure it out" outcome — the idea stews as a faint memory.
function stewIdea(person, state, result) {
  addMemory(person, `Had an odd idea but couldn't make it work yet.`, 'experiment', state.day, { valence: -0.2 });
  person.thought = result.idea + ' ...but I can\'t make it work.';
}

// Trim a model's free-text "making" into a short, clean material label.
function cleanLabel(making) {
  if (!making || typeof making !== 'string') return null;
  const t = making.trim().replace(/^(a|an|the|some)\s+/i, '').slice(0, 40);
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null;
}

// Recompute the village-wide tech effect multipliers from current known tech.
// Called after a breakthrough and after a death (oral-tradition knowledge loss).
export function recomputeTechEffects(state) {
  state.spoilageMult = 1;
  state.farmYieldMult = 1;
  for (const techId of Object.keys(state.knownTech || {})) {
    const tech = recipeFor(state, techId);
    if (!tech) continue;
    const e = tech.effect || {};
    if (e.type === 'storage') state.spoilageMult = Math.min(state.spoilageMult, 1 - (e.food || 0));
    if (e.type === 'farmYield') state.farmYieldMult = Math.max(state.farmYieldMult, e.mult || 1);
  }
}
