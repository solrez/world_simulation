import { PERSONALITIES, LOCATIONS, MAP_W, MAP_H, TERRAIN, RELATIONSHIP_STAGES, LIFE_STAGES, MOOD_LOCATIONS, CHILD_NAMES, AMBIENT_EVENTS, WILDLIFE_TYPES, GATE, YEARS_PER_DAY, TICKS_PER_DAY, GESTATION_DAYS, CONCEPTION_CHANCE, FOOD_TYPES, Q_EPSILON, SEASON_ABUNDANCE, FARM, GOSSIP_CHANCE, FRAILTY_START_AGE, FRAILTY_PER_DAY, HEALTH_REGEN_PER_DAY, INJURY_HEAL_PER_DAY, HEALER_HEAL_BONUS, FRAILTY_SPEED_PENALTY, INJURY_SPEED_PENALTY, RESOURCE_NODES, DISCOVERY, IDEA, TECH_GRAPH, PROTOTYPE, WILDLIFE_TARGETS, WILDLIFE_RESPAWN, SCHEMA_VERSION, buildMaterialCatalog } from '../utils/constants.js';
import { nearestWalkable } from './pathfinding.js';
import { clearCompletedGoal } from './goals.js';
import { nearestVisiblePrey, perceive } from './vision.js';
import { generateGroupDialogue, generateAction, generateGossip, generateTeaching, generateIdeation, generateAvatarReply } from './ai.js';
import { physicsGate } from './tech/physics.js';
import { mintRecipe } from './tech/derive.js';
import { simlog } from './log.js';
import { blankTechMetrics, recordAttempt, recordGate, recordMint, recordBreakthroughMetric, summarizeTech } from './tech/metrics.js';
import { getTimeOfDay, personTimeOfDay, distBetween, locationAt, clamp, getWalkableGrid, moveToward, setGoal, goToLocation, goToPerson } from './movement.js';
import { addMemory, decayMemories, personValence, weightedLocationPick, setEmote } from './memory.js';
import { chronotypeFor, recordModelResult, reassignFlakyModels, pickModelWeighted } from './models.js';
import { addFood, totalFood, eatFood, takeFromLarder, patchYield, depletePatch, depleteGrove, regrowPatches, updatePond, growField, fieldReady } from './food.js';
import { blankReputation, bumpReputation, decayReputation, pickGossipTarget, applyGossip, reputationLabel } from './reputation.js';
import { rewardAction, topSkill, bestSpecialist, qValue, qBestActions } from './q.js';
import { saveConversationToArchive } from './archive.js';
import { generateTerrain } from './terrain.js';

// Re-exported from ./archive.js to preserve the engine's public API surface.
export { getConversationArchive, getConversationArchiveFromDisk, downloadConversationArchive, downloadFullWorldState } from './archive.js';

// ── Person ──

let nextPersonId = 100;

function getLifeStage(age) {
  if (age < 3) return LIFE_STAGES.BABY;
  if (age < 13) return LIFE_STAGES.CHILD;
  if (age < 18) return LIFE_STAGES.TEEN;
  if (age < 55) return LIFE_STAGES.ADULT;
  return LIFE_STAGES.ELDER;
}

// daily schedule slots
const SCHEDULE = {
  night:     'sleep',
  morning:   'work',
  midday:    'eat',
  afternoon: 'free',
  evening:   'social',
};

const AMBITION_POOL = [
  { id: 'find_partner', label: 'Find a partner', check: p => !!p.partner },
  { id: 'have_child', label: 'Have a child', check: p => p.children.length > 0 },
  { id: 'build_home', label: 'Build a home', check: p => !!p.home },
  { id: 'master_fishing', label: 'Master fishing', check: p => p.skills.fishing > 50 },
  { id: 'master_foraging', label: 'Master foraging', check: p => p.skills.foraging > 50 },
  { id: 'master_building', label: 'Master building', check: p => p.skills.building > 50 },
  { id: 'master_storytelling', label: 'Become a great storyteller', check: p => p.skills.storytelling > 50 },
  { id: 'make_friends', label: 'Make 3 friends', check: (p) => Object.values(p.relationships).filter(r => r.stage === 'friend' || r.stage === 'close_friend').length >= 3 },
  { id: 'explore_all', label: 'Visit every location', check: () => false },
];

function generateAmbitions() {
  const pool = [...AMBITION_POOL];
  const ambitions = [];
  const count = 2 + Math.floor(Math.random() * 2); // 2-3 ambitions
  for (let i = 0; i < count && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const a = pool.splice(idx, 1)[0];
    ambitions.push({ ...a, completed: false });
  }
  return ambitions;
}

function initPerson(config, index, startX, startY) {
  const cf = LOCATIONS.CAMPFIRE;
  const angle = (index / Math.max(1, PERSONALITIES.length)) * Math.PI * 2;
  const dist = 3 + Math.random() * 5;
  return {
    ...config,
    id: config.id ?? index,
    x: startX ?? (cf.x + Math.cos(angle) * dist),
    y: startY ?? (cf.y + Math.sin(angle) * dist),
    targetX: null, targetY: null,
    path: null, _pathDest: null,
    currentLocation: 'village',
    // the LLM this agent "thinks" with — distinct model = distinct voice. A child
    // may inherit its model below; otherwise pick weighted by recent reliability
    // (config._modelStats passed in when known; undefined → uniform random).
    model: config.model || pickModelWeighted(config._modelStats),
    lifeStage: getLifeStage(config.age),
    // chronotype shifts this agent's effective schedule clock (early/normal/night)
    chronotype: config.chronotype || chronotypeFor(config.traits),
    mood: 'neutral',
    activity: 'exploring',
    relationships: {},
    conversationId: null,
    conversationCooldown: 0,
    actionCooldown: 0,
    // escalation gate
    gateCooldown: 0,
    eventSeen: 0,
    pendingLLM: false,
    thought: null,
    idle: 0,
    speed: 0.35 + Math.random() * 0.1, // brisk walking pace
    // needs
    hunger: 15,
    tiredness: 10,
    loneliness: 30,
    // life
    partner: null,
    home: null,
    pregnant: false,
    pregnancyTimer: 0,
    pregnancyDay: 0,
    children: [],
    parents: [],
    // memory
    memories: [],
    // visual
    emote: null,
    emoteTimer: 0,
    sleeping: false,
    eating: false,
    // behavior lock
    currentGoal: null,
    // skills
    skills: { fishing: 0, building: 0, foraging: 0, storytelling: 0, healing: 0, crafting: 0, hunting: 0, farming: 0 },
    // alive
    alive: true,
    // ambitions — generated at init
    ambitions: generateAmbitions(),
    // grief
    griefTimer: 0,
    griefTarget: null,
    // illness
    sick: false,
    sickTimer: 0,
    // health, frailty & injury — gradual decline gives death a lead-up
    health: 100,
    frailty: config.age >= FRAILTY_START_AGE ? Math.min(100, (config.age - FRAILTY_START_AGE) * FRAILTY_PER_DAY) : 0,
    injury: 0,        // 0..100 severity; heals over days, faster with a healer
    acheTimer: 0,     // throttles "my knees ache" complaints
    // favorite location
    favoriteLocation: null,
    // each agent's private read on others (gossip nudges these); keyed by name
    reputationBeliefs: {},
    // inventory (materials) + typed food larder. Tech materials (clay, copper,
    // flint, coal, charcoal, copper_ingot) start at 0 and accrue once noticed/made.
    inventory: { wood: 0, stone: 0, thatch: 0, clay: 0, copper: 0, flint: 0, coal: 0, charcoal: 0, copper_ingot: 0 },
    larder: { meat: 0, fish: 0, berries: 3, crops: 0 },
    lastEaten: null,
    // crafted tools that boost gathering yields, plus in-progress craft state
    tools: {},
    craftTool: null,
    craftProgress: 0,
    foodGathered: 0,
    // Q-learning: learned action values + per-action stats
    qValues: {},
    actionStats: {},
    // social
    flirting: null,
    // awe — sense of higher power
    awe: 0,
    // building project
    buildProject: null,
    // conversation log — actual past dialogues stored per person
    conversationLog: [], // [{participants: [], lines: [{speaker, text}], day, location}]
    // ── invention / tech (Phases 1-5) ──
    noticedResources: {},   // { [material]: { near, look, day } } — what they've personally spotted
    knownTech: {},          // { [techId]: true } — inventions THIS person can do
    prototype: null,        // { techId, label, progress, attemptsLeft, failureChance } while experimenting
    techRole: null,         // 'smith' | 'potter' | ... once they invent the right thing
    ideaCooldown: 0,        // ticks before another ideation call
    pendingIdea: false,     // flagged by the gate → App fires runIdeation
  };
}

function initRelationships(people) {
  for (const p of people) {
    for (const other of people) {
      if (p.name === other.name) continue;
      if (p.relationships[other.name]) continue;
      const isFamily = p.parents.includes(other.name) || other.parents.includes(p.name);
      // personality compatibility for initial attraction
      const sharedTraits = p.traits.filter(t => other.traits.includes(t)).length;
      const baseAttraction = canBeAttracted(p, other) ? 35 + sharedTraits * 8 + Math.floor(Math.random() * 15) : 0;
      p.relationships[other.name] = {
        affection: isFamily ? 70 : 50,
        trust: isFamily ? 70 : 50,
        attraction: baseAttraction,
        familiarity: isFamily ? 40 : 0,
        stage: isFamily ? RELATIONSHIP_STAGES.FRIEND : RELATIONSHIP_STAGES.STRANGER,
        jealousy: 0,
      };
    }
  }
}

function canBeAttracted(a, b) {
  if (a.lifeStage === LIFE_STAGES.BABY || a.lifeStage === LIFE_STAGES.CHILD) return false;
  if (b.lifeStage === LIFE_STAGES.BABY || b.lifeStage === LIFE_STAGES.CHILD) return false;
  if (a.parents.includes(b.name) || b.parents.includes(a.name)) return false;
  return true;
}

// ── State ──

// ── Catalog access (Phase 0) ──
// A deep-ish clone of the hidden TECH_GRAPH seed into a mutable per-run catalog.
// Recipe nodes are shallow data (no functions), so we clone fields and copy the
// array-valued ones (prereqs / matches) and the effect object defensively, so a
// runtime mutation to one run's catalog never leaks back into the constant.
function cloneRecipeCatalog() {
  const cat = {};
  for (const [id, tech] of Object.entries(TECH_GRAPH)) {
    cat[id] = {
      ...tech,
      prereqMaterials: [...(tech.prereqMaterials || [])],
      prereqKnowledge: [...(tech.prereqKnowledge || [])],
      matches: [...(tech.matches || [])],
      effect: { ...(tech.effect || {}) },
    };
  }
  return cat;
}

// The one read path for a recipe by id. Reads the runtime catalog, falling back
// to the TECH_GRAPH seed so a half-migrated/older save (no recipeCatalog yet)
// still resolves built-in techs. All engine code goes through this, never
// TECH_GRAPH[id] directly, so minted recipes are visible everywhere.
function recipeFor(state, id) {
  return state?.recipeCatalog?.[id] || TECH_GRAPH[id];
}

// All recipes available this run (built-ins + any minted). Used by the idea
// matcher and anything that iterates the whole graph.
function allRecipes(state) {
  return Object.values(state?.recipeCatalog || TECH_GRAPH);
}

// Upgrade a loaded save in place to the current SCHEMA_VERSION. Older saves
// predate the runtime catalogs; seed them so the rest of the engine finds them.
// Add a new `if (v < N)` block for each future schema bump — never break on load.
export function migrateState(state) {
  if (!state || typeof state !== 'object') return state;
  const v = state.schemaVersion || 0;
  if (v < 1) {
    if (!state.recipeCatalog) state.recipeCatalog = cloneRecipeCatalog();
    if (!state.materialCatalog) state.materialCatalog = buildMaterialCatalog();
    if (!state.rejectedCombos) state.rejectedCombos = {};
    if (!state.techMetrics) state.techMetrics = blankTechMetrics();
  }
  state.schemaVersion = SCHEMA_VERSION;
  return state;
}

export function createSimulation() {
  const terrain = generateTerrain();
  const people = PERSONALITIES.map((p, i) => initPerson(p, i));
  initRelationships(people);
  const reputation = {};
  for (const p of people) reputation[p.name] = blankReputation();
  return {
    // schema version of this state shape — read by migrateState() on load
    schemaVersion: SCHEMA_VERSION,
    terrain, people, buildings: [],
    wildlife: spawnInitialWildlife(),
    day: 1, hour: 8, minute: 0,
    timeOfDay: 'morning', weather: 'clear',
    season: 'spring',
    // shared village larder (typed) + resource-patch depletion state
    larder: { meat: 8, fish: 12, berries: 20, crops: 6 },
    patches: { 'Berry Bush': 1, 'Fishing Spot': 1, 'Meadow': 1, 'Grove': 1 },
    // the communal field: fallow to start, waiting for someone to sow it
    field: { planted: false, stage: 0, plantedDay: null },
    // pond water level (rises with rain, shrinks in drought/winter) — visible
    pond: { level: 1 },
    // collective village reputation: { [name]: { generous, kind, skilled, ... } }
    reputation,
    // ── invention / tech (Phases 1,2,5) ──
    // Hidden resource nodes on the map. `discoveredBy` is the set of names who've
    // noticed each (renderer reveals a node once anyone has). Cloned from the
    // constant so per-run discovery state lives on state, not the module.
    resourceNodes: RESOURCE_NODES.map((n, i) => ({ ...n, id: i, discoveredBy: {} })),
    // ── Runtime catalogs (Phase 0) ── lifted from module constants so discovery
    // can WRITE into them. recipeCatalog is seeded from the hidden TECH_GRAPH;
    // materialCatalog from the base-material seed. Both are per-run and mutable.
    // Read them via recipeFor(state, id) / state.materialCatalog[id], never the
    // raw TECH_GRAPH constant, so minted recipes/materials are picked up too.
    recipeCatalog: cloneRecipeCatalog(),
    materialCatalog: buildMaterialCatalog(),
    // normalized input+process keys that failed the physics gate — so the same
    // dead-end idea isn't re-proposed every cooldown (Phase 1 dedup, seeded here).
    rejectedCombos: {},
    // running tally of discovery behavior (rates/health) for the panel + logs.
    techMetrics: blankTechMetrics(),
    // village knowledge pool: { [techId]: { by, day } } — someone alive once knew it.
    knownTech: {},
    // chronicle of breakthroughs (for the Invention Log panel): { techId, label, by, day }
    inventions: [],
    // per-model reliability stats for the assignment router (#8)
    modelStats: {},
    stats: { totalBirths: 0, totalDeaths: 0, totalPartnerships: 0, totalConversations: 0 },
    events: [], conversations: [], activeConversations: [],
    nextConvoId: 1, tick: 0, speed: 1, paused: false,
  };
}

// ── Wildlife ──

let nextAnimalId = 1000;

function spawnInitialWildlife() {
  const animals = [];
  // 2-3 deer in the grove area
  for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
    animals.push(createAnimal('deer', 4 + Math.random() * 8, 3 + Math.random() * 6));
  }
  // 3-4 rabbits scattered
  for (let i = 0; i < 3 + Math.floor(Math.random() * 2); i++) {
    animals.push(createAnimal('rabbit', Math.random() * MAP_W, Math.random() * MAP_H));
  }
  // 1 boar near grove
  animals.push(createAnimal('boar', 8 + Math.random() * 4, 8 + Math.random() * 4));
  // 2-3 birds
  for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
    animals.push(createAnimal('bird', Math.random() * MAP_W, Math.random() * MAP_H));
  }
  // wolf (sometimes)
  if (Math.random() < 0.4) {
    animals.push(createAnimal('wolf', 25 + Math.random() * 4, 3 + Math.random() * 4));
  }
  return animals;
}

function createAnimal(type, x, y) {
  const template = WILDLIFE_TYPES.find(w => w.type === type) || WILDLIFE_TYPES[0];
  return {
    id: nextAnimalId++,
    type, x, y,
    targetX: null, targetY: null,
    speed: template.speed,
    fleeRange: template.fleeRange,
    foodValue: template.foodValue,
    color: template.color,
    dangerous: template.dangerous || false,
    attackRange: template.attackRange || 0,
    alive: true,
    tamed: false,
    idle: 0,
    currentLocation: locationAt(x, y),
  };
}

function updateWildlife(state) {
  for (const animal of state.wildlife) {
    if (!animal.alive) continue;

    // flee from nearby people
    const nearestPerson = state.people.find(p => p.alive !== false && distBetween(p, animal) < animal.fleeRange);
    if (nearestPerson && animal.fleeRange > 0 && !animal.tamed) {
      const dx = animal.x - nearestPerson.x, dy = animal.y - nearestPerson.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0.1) {
        animal.x += (dx / dist) * animal.speed;
        animal.y += (dy / dist) * animal.speed;
      }
      animal.x = clamp(animal.x, 0, MAP_W - 1);
      animal.y = clamp(animal.y, 0, MAP_H - 1);
      continue;
    }

    // wolves attack nearby people
    if (animal.dangerous && animal.attackRange > 0) {
      const target = state.people.find(p => p.alive !== false && !p.sleeping && distBetween(p, animal) < animal.attackRange);
      if (target && Math.random() < 0.001) {
        target.hunger = Math.min(100, target.hunger + 15);
        target.tiredness = Math.min(100, target.tiredness + 10);
        target.mood = 'anxious';
        // a real wound — injury heals over days (faster with a healer) and can
        // worsen into death if untreated; telegraphs danger before it's fatal (#10)
        target.injury = Math.min(100, (target.injury || 0) + 30 + Math.random() * 20);
        target.health = clamp((target.health ?? 100) - 12, 0, 100);
        setEmote(target, 'fear', 30);
        addMemory(target, `Was attacked by a ${animal.type}!`, 'danger', state.day, { location: locationAt(target.x, target.y) });
        state.events.push({ day: state.day, hour: state.hour, participants: [target.name], summary: `🐺 ${target.name} was attacked by a ${animal.type}!`, type: 'danger' });
      }
    }

    // random wandering
    if (animal.targetX !== null) {
      const dx = animal.targetX - animal.x, dy = animal.targetY - animal.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.5) { animal.targetX = null; animal.targetY = null; }
      else {
        animal.x += (dx / dist) * animal.speed * 0.5;
        animal.y += (dy / dist) * animal.speed * 0.5;
      }
    } else {
      animal.idle++;
      if (animal.idle > 30 + Math.random() * 40) {
        animal.targetX = clamp(animal.x + (Math.random() - 0.5) * 10, 1, MAP_W - 2);
        animal.targetY = clamp(animal.y + (Math.random() - 0.5) * 10, 1, MAP_H - 2);
        animal.idle = 0;
      }
    }

    animal.currentLocation = locationAt(animal.x, animal.y);
  }

  // ── population management ── prune old carcasses and repopulate prey species
  // that have dropped below their target, so hunting stays sustainable and the
  // map never empties out. Runs on a short cadence to feel responsive.
  if (state.tick % WILDLIFE_RESPAWN.CHECK_EVERY === 0) {
    // remove carcasses that have lingered long enough (keeps the array bounded)
    state.wildlife = state.wildlife.filter(w =>
      w.alive || (state.tick - (w._diedTick ?? 0)) < WILDLIFE_RESPAWN.CARCASS_PRUNE_AGE);

    // count living animals per species
    const counts = {};
    for (const w of state.wildlife) if (w.alive) counts[w.type] = (counts[w.type] || 0) + 1;

    // any prey species below target → a chance to spawn one (near its preferred
    // area when we have one, else anywhere on grass)
    const below = Object.entries(WILDLIFE_TARGETS).filter(([t, target]) => (counts[t] || 0) < target);
    if (below.length && Math.random() < WILDLIFE_RESPAWN.SPAWN_CHANCE) {
      // bias toward the species furthest below its target
      below.sort((a, b) => ((counts[a[0]] || 0) - a[1]) - ((counts[b[0]] || 0) - b[1]));
      const type = below[0][0];
      const spot = spawnSpotFor(type, state);
      state.wildlife.push(createAnimal(type, spot.x, spot.y));
    }

    // wolves: a lone predator wanders in rarely if none is around (a threat, not
    // a managed resource) — keeps danger present without overrunning the map.
    const wolves = (counts.wolf || 0);
    if (wolves === 0 && Math.random() < WILDLIFE_RESPAWN.WOLF_CHANCE) {
      state.wildlife.push(createAnimal('wolf', MAP_W - 3 - Math.random() * 3, 2 + Math.random() * 4));
    }
  }
}

// Pick a plausible spawn point for a species: deer/boar favor the wooded grove
// area, birds & rabbits scatter. Always lands on non-water ground.
function spawnSpotFor(type, state) {
  const grove = LOCATIONS.TREE_GROVE;
  for (let tries = 0; tries < 20; tries++) {
    let x, y;
    if (type === 'deer' || type === 'boar') {
      x = grove.x + (Math.random() - 0.5) * 10;
      y = grove.y + (Math.random() - 0.5) * 10;
    } else {
      x = Math.random() * MAP_W;
      y = Math.random() * MAP_H;
    }
    x = clamp(x, 1, MAP_W - 2); y = clamp(y, 1, MAP_H - 2);
    if (state.terrain?.[Math.round(y)]?.[Math.round(x)]?.type !== TERRAIN.WATER) return { x, y };
  }
  return { x: grove.x, y: grove.y };
}

// ── Hunting: continuous active pursuit ──
//
// A hunter doesn't aim at a stale snapshot. Every tick, while activity is
// 'hunting', they look for prey IN SIGHT (vision), lock onto the nearest, and
// chase its LIVE position — which keeps moving because the animal flees (see
// updateWildlife's fleeRange). They only catch it when they close the gap. This
// is the whole point of giving agents eyes: the world moves, and they react to
// where things actually are, not where they were when the hunt began.
function processHunting(person, state) {
  if (person.activity !== 'hunting') return;
  if (person.sleeping || person.eating || person.conversationId) { person.activity = 'idle'; return; }

  // re-acquire a target each tick from what's actually visible
  const tooHard = (person.skills?.hunting || 0) < 8; // novices avoid wolves
  let prey = person._huntTargetId != null
    ? (state.wildlife || []).find(w => w.id === person._huntTargetId && w.alive)
    : null;
  // if we lost sight of our quarry (it fled out of view), look for another
  if (!prey || distBetween(person, prey) > 12) {
    prey = nearestVisiblePrey(person, state, { allowDangerous: !tooHard });
    person._huntTargetId = prey ? prey.id : null;
  }

  if (!prey) {
    // nothing in sight — roam toward open ground to scan for game, give up after a while
    person._huntScan = (person._huntScan || 0) + 1;
    if (person._huntScan > 40) { person.activity = 'idle'; person._huntScan = 0; person.thought = 'No game in sight. Giving up the hunt.'; return; }
    if (person.targetX === null) { goToLocation(person, 'Grove'); }
    return;
  }
  person._huntScan = 0;

  const d = distBetween(person, prey);
  if (d < 1.6) {
    // close enough to strike
    const huntSkill = person.skills?.hunting || 0;
    const seasonHunt = (SEASON_ABUNDANCE[state.season] || { hunt: 1 }).hunt;
    const catchChance = (0.30 + huntSkill * 0.006) * seasonHunt;
    if (Math.random() < catchChance) {
      prey.alive = false;
      prey._diedTick = state.tick; // for carcass pruning in updateWildlife
      const meat = Math.max(2, Math.round(prey.foodValue));
      addFood(person, 'meat', meat);
      person.foodGathered = (person.foodGathered || 0) + meat;
      gainSkill(person, 'hunting', 1);
      rewardAction(person, 'hunt', meat, state);
      setEmote(person, 'sparkle', 20);
      person.activity = 'idle'; person._huntTargetId = null;
      person.thought = `Got the ${prey.type}! ${meat} meat.`;
      addMemory(person, `Caught a ${prey.type}! Got ${meat} meat.`, 'achievement', state.day, { location: person.currentLocation });
      state.events.push({ day: state.day, hour: state.hour, participants: [person.name], summary: `🏹 ${person.name} caught a ${prey.type}!`, type: 'hunt' });
      bumpReputation(state, person.name, 'skilled', 2);
      if (prey.dangerous) bumpReputation(state, person.name, 'brave', 4); // bringing down a wolf is talked about
    } else if (prey.dangerous && Math.random() < 0.25) {
      // dangerous prey fights back — real risk the Q-table learns to weigh
      person.hunger = Math.min(100, person.hunger + 8);
      person.tiredness = Math.min(100, person.tiredness + 8);
      setEmote(person, 'fear', 20);
      rewardAction(person, 'hunt', -3, state);
      person.activity = 'idle'; person._huntTargetId = null;
      addMemory(person, `A ${prey.type} fought back while hunting!`, 'danger', state.day, { location: person.currentLocation });
    }
    // a miss just continues the chase next tick
  } else {
    // pursue the LIVE position — this is the chase. Pathfind around water.
    person.targetX = prey.x;
    person.targetY = prey.y;
    moveToward(person, prey.x, prey.y, state);
    person.tiredness = Math.min(100, person.tiredness + 0.01); // chasing tires you
  }
}

// ── Helpers ──

// Which productive action to do, ε-greedy over learned Q-values. This is the
// local adaptation between LLM calls: agents lean into what's worked, but still
// explore (Q_EPSILON) so they discover hunting/building pay off.
const WORK_ACTIONS = ['fish', 'forage', 'hunt', 'chop_wood', 'farm'];
function pickWorkAction(person, state) {
  // a ripe field is free food — go reap it; a fallow field in a growing season
  // is worth sowing so the crop cycle keeps going (otherwise it dies after one
  // harvest because nobody re-plants). Both bias toward farming, with some noise.
  const f = state.field;
  if (f) {
    if (f.planted && f.stage >= FARM.RIPE && Math.random() < 0.7) return 'farm';
    if (!f.planted && FARM.GROW_SEASONS.includes(state.season) && Math.random() < 0.3) return 'farm';
  }
  if (Math.random() < Q_EPSILON) return WORK_ACTIONS[Math.floor(Math.random() * WORK_ACTIONS.length)];
  let best = WORK_ACTIONS[0], bestV = -Infinity;
  for (const a of WORK_ACTIONS) {
    const v = qValue(person, state, a) + Math.random() * 0.01; // tiny tiebreak jitter
    if (v > bestV) { bestV = v; best = a; }
  }
  return best;
}
function startWorkAction(person, action, state) {
  const map = {
    fish: ['Fishing Spot', 'gathering'],
    forage: ['Berry Bush', 'gathering'],
    chop_wood: ['Grove', 'chopping'],
    farm: ['Field', 'farming'],
  };
  if (action === 'hunt') {
    // begin a hunt — processHunting takes over each tick, finding prey via sight
    // and chasing it. Don't lock a goal (that would freeze the pursuit).
    const tooHard = (person.skills?.hunting || 0) < 8;
    const prey = nearestVisiblePrey(person, state, { allowDangerous: !tooHard })
      || (state.wildlife || []).find(w => w.alive); // none in sight → go look near one
    if (prey) {
      person.activity = 'hunting';
      person._huntTargetId = null; person._huntScan = 0;
      person.targetX = prey.x; person.targetY = prey.y;
      person.thought = 'Spotted something to hunt...';
      return;
    }
    action = 'forage'; // genuinely no animals anywhere → fall back
  }
  const [loc, act] = map[action] || map.forage;
  goToLocation(person, loc);
  person.activity = act;
  setGoal(person, 'work', loc, 40);
}

function pickTarget(person, people, state) {
  // each agent runs on their own chronotype-shifted clock, so the village isn't
  // all asleep or all working at once.
  const schedule = SCHEDULE[personTimeOfDay(person, state)] || 'free';

  // daily routine drives behavior
  switch (schedule) {
    case 'sleep':
      // it's their bedtime. If they own a home and are at all tired, head there to
      // sleep (this is what makes a built house visibly used at night). The
      // walk-home-then-sleep is handled by beginSleep.
      if (person.home && person.tiredness > 15) { beginSleep(person, 500); return; }
      if (person.tiredness > 30) return; // otherwise let the reflex handle it
      // those still awake on their clock wander rather than freeze
      if (person.chronotype === 'night' || person.traits.includes('restless') || Math.random() < 0.2) {
        goToLocation(person, person.favoriteLocation || 'Campfire');
        setGoal(person, 'wander', null, 20);
      }
      return;

    case 'work':
      // pick the work that's been paying off (learned), with some exploration
      if (Math.random() < 0.6) {
        startWorkAction(person, pickWorkAction(person, state), state);
      } else {
        pickExploreTarget(person);
      }
      return;

    case 'eat':
      if (person.hunger > 30) {
        const foodLocs = ['Berry Bush', 'Fishing Spot'];
        goToLocation(person, foodLocs[Math.floor(Math.random() * foodLocs.length)]);
        person.activity = 'gathering';
        setGoal(person, 'eat', null, 30);
      } else {
        pickSocialTarget(person, people);
      }
      return;

    case 'social':
    case 'free':
      // mood-driven or social
      if (person.partner && Math.random() < 0.3) {
        const partner = people.find(p => p.name === person.partner);
        if (partner && !partner.sleeping) { goToPerson(person, partner); setGoal(person, 'seek', partner.name, 25); return; }
      }
      // homebodies (loners/elders) gravitate to their own spot — territoriality
      if (person.favoriteLocation && person.loneliness < 45) {
        const homey = person.traits.includes('evasive') || person.lifeStage === LIFE_STAGES.ELDER ? 0.5 : 0.25;
        if (Math.random() < homey) { goToLocation(person, person.favoriteLocation); setGoal(person, 'wander', null, 25); return; }
      }
      if (person.loneliness > 40 || Math.random() < 0.4) {
        pickSocialTarget(person, people);
      } else {
        pickMoodTarget(person);
      }
      return;
  }
}

function pickSocialTarget(person, people) {
  // go to where other people are, or campfire
  const others = people.filter(p => p.name !== person.name && !p.sleeping);
  if (others.length && Math.random() < 0.6) {
    const target = others[Math.floor(Math.random() * others.length)];
    goToPerson(person, target);
    person.activity = 'seeking';
    setGoal(person, 'seek', target.name, 25);
  } else {
    goToLocation(person, 'Campfire');
    setGoal(person, 'social', null, 20);
  }
}

function pickMoodTarget(person) {
  const moodLocs = MOOD_LOCATIONS[person.mood];
  if (moodLocs && Math.random() < 0.7) {
    const name = weightedLocationPick(person, moodLocs);
    goToLocation(person, name);
  } else {
    pickExploreTarget(person);
  }
  setGoal(person, 'wander', null, 25);
}

function pickExploreTarget(person) {
  const locs = Object.values(LOCATIONS);
  const name = weightedLocationPick(person, locs.map(l => l.name));
  const loc = locs.find(l => l.name === name) || locs[Math.floor(Math.random() * locs.length)];
  person.targetX = loc.x + (Math.random() - 0.5) * 4;
  person.targetY = loc.y + (Math.random() - 0.5) * 4;
  person.targetX = clamp(person.targetX, 1, MAP_W - 2);
  person.targetY = clamp(person.targetY, 1, MAP_H - 2);
  person.activity = 'exploring';
  setGoal(person, 'wander', null, 30);
}

// ── Relationship stages ──

function updateRelationshipStage(person, otherName, people) {
  const rel = person.relationships[otherName];
  if (!rel) return;
  const other = people.find(p => p.name === otherName);
  if (!other) return;
  const otherRel = other.relationships[person.name];
  const { affection, trust, attraction, familiarity, stage } = rel;

  // partnered is the final positive stage — only degrade if relationship collapses
  if (stage === RELATIONSHIP_STAGES.PARTNERED) {
    // partnered can degrade to dating if trust/affection drops
    if (affection < 35 || trust < 30) {
      rel.stage = RELATIONSHIP_STAGES.DATING;
      addMemory(person, `Relationship with ${otherName} is struggling`, 'life', 0, { valence: -1.5 });
    }
    return;
  }

  // dating can progress to partnered or degrade
  if (stage === RELATIONSHIP_STAGES.DATING) {
    if (affection > 70 && trust > 65 && familiarity > 40) {
      rel.stage = RELATIONSHIP_STAGES.PARTNERED;
      if (otherRel) otherRel.stage = RELATIONSHIP_STAGES.PARTNERED;
      setEmote(person, 'heart', 50);
      setEmote(other, 'heart', 50);
      addMemory(person, `Became partners with ${otherName}!`, 'life', 0);
      addMemory(other, `Became partners with ${person.name}!`, 'life', 0);
    }
    // dating degrades if feelings fade
    if (affection < 40 && trust < 35) {
      rel.stage = RELATIONSHIP_STAGES.CLOSE_FRIEND;
      if (person.partner === otherName) {
        person.partner = null;
        other.partner = null;
        person.mood = 'sad';
        addMemory(person, `Stopped dating ${otherName}`, 'life', 0, { valence: -1.5 });
      }
    }
    return;
  }

  // negative stages
  if (affection < 20 && trust < 20 && stage !== RELATIONSHIP_STAGES.ENEMY) {
    rel.stage = RELATIONSHIP_STAGES.ENEMY; return;
  }
  if (affection < 35 && trust < 30 && stage !== RELATIONSHIP_STAGES.RIVAL && stage !== RELATIONSHIP_STAGES.STRANGER) {
    rel.stage = RELATIONSHIP_STAGES.RIVAL; return;
  }

  // positive progression
  if (familiarity > 5 && stage === RELATIONSHIP_STAGES.STRANGER)
    rel.stage = RELATIONSHIP_STAGES.ACQUAINTANCE;
  if (affection > 55 && trust > 50 && familiarity > 15 && stage === RELATIONSHIP_STAGES.ACQUAINTANCE)
    rel.stage = RELATIONSHIP_STAGES.FRIEND;
  if (affection > 65 && trust > 60 && familiarity > 30 && stage === RELATIONSHIP_STAGES.FRIEND)
    rel.stage = RELATIONSHIP_STAGES.CLOSE_FRIEND;
  if (attraction > 60 && affection > 60 && familiarity > 25 &&
      (stage === RELATIONSHIP_STAGES.FRIEND || stage === RELATIONSHIP_STAGES.CLOSE_FRIEND) &&
      canBeAttracted(person, other)) {
    rel.stage = RELATIONSHIP_STAGES.ATTRACTED;
    setEmote(person, 'heart', 30);
  }

  // mutual attraction → dating
  if (stage === RELATIONSHIP_STAGES.ATTRACTED && otherRel &&
      otherRel.stage === RELATIONSHIP_STAGES.ATTRACTED && !person.partner && !other.partner) {
    rel.stage = RELATIONSHIP_STAGES.DATING;
    otherRel.stage = RELATIONSHIP_STAGES.DATING;
    person.partner = other.name;
    other.partner = person.name;
    setEmote(person, 'heart', 40);
    setEmote(other, 'heart', 40);
    addMemory(person, `Started dating ${other.name}!`, 'life', 0);
    addMemory(other, `Started dating ${person.name}!`, 'life', 0);
    // a new couple shares a home: if one already has one, the other moves in
    shareHomeWithPartner(person, other);
  }
}

// ── Needs ──

function updateNeeds(person, timeOfDay, weather) {
  // hunger — very slow, ~8 game-hours to go from 0→70 (hungry)
  // 480 ticks (8 hrs) × rate ≈ 70. So rate ≈ 0.015 during day
  const hungerRate = timeOfDay === 'night' ? 0.008 : (weather === 'rainy' ? 0.012 : 0.015);
  person.hunger = clamp(person.hunger + hungerRate, 0, 100);

  // tiredness — awake ~16 hrs before exhausted
  if (person.sleeping) {
    // sleeping in your own home rests you faster (a real payoff for building)
    const atHome = person.home && Math.abs(person.x - person.home.x) < 2 && Math.abs(person.y - person.home.y) < 2;
    person.tiredness = clamp(person.tiredness - (atHome ? 0.3 : 0.2), 0, 100);
    if (person.tiredness <= 3) {
      person.sleeping = false;
      person.activity = 'wandering';
      person.currentGoal = null;
      setEmote(person, null, 0);
    }
  } else {
    const tiredRate = timeOfDay === 'night' ? 0.04 : (person.activity === 'working' ? 0.03 : 0.02);
    person.tiredness = clamp(person.tiredness + tiredRate, 0, 100);
  }

  // loneliness
  if (person.conversationId) {
    person.loneliness = clamp(person.loneliness - 0.3, 0, 100);
  } else {
    const rate = person.partner ? 0.015 : 0.025;
    person.loneliness = clamp(person.loneliness + rate, 0, 100);
  }

  // awe (sense of the divine) fades when the gods stay quiet — it's only renewed
  // by an actual god-power. So "something divine is watching" reflects RECENT
  // intervention, not a permanent religion the agents invent on their own.
  if (person.awe > 0) person.awe = Math.max(0, person.awe - 0.02);

  // eating — consumes from personal food or village food
  if (person.eating) {
    person.hunger = clamp(person.hunger - 0.8, 0, 100);
    if (person.hunger <= 5) {
      person.eating = false;
      person.activity = 'wandering';
      person.currentGoal = null;
    }
  }
}

// ── Escalation gate ──
//
// Per-person, per-tick verdict that decides who gets to "think":
//   REFLEX   — a one-answer survival situation; handle it locally, no LLM call.
//   ESCALATE — an interesting situation (conflict, competing desires, fresh
//              event, goal tension); mark pendingLLM so the LLM decides. The
//              LLM keeps ALL character/social/goal choices.
//   IDLE     — nothing urgent; the cheap local schedule wander handles it.
//
// This removes the old three-way race (needs + schedule + LLM all firing on the
// same tick) and stops spending LLM calls on reflexes that have one answer.
function escalationGate(person, people, state) {
  if (person.lifeStage === LIFE_STAGES.BABY) return { verdict: 'IDLE' };
  // already acting on a reflex — let it run
  if (person.sleeping || person.eating) return { verdict: 'IDLE' };

  // ── reflexes: single-answer survival, handled locally ──
  // These are INSTINCTIVE and fire even mid-conversation: a starving or
  // exhausted person breaks off and tends to their body. runConversation checks
  // for this and bails the talker out, so nobody dies mid-sentence.
  if (person.tiredness > GATE.EXHAUSTED) return { verdict: 'REFLEX', reflex: 'sleep' };
  if (state.timeOfDay === 'night' && person.tiredness > GATE.NIGHT_TIRED && !person.targetX && !person.conversationId) {
    return { verdict: 'REFLEX', reflex: 'sleep' };
  }
  if (person.sick && person.tiredness > GATE.SICK_TIRED) return { verdict: 'REFLEX', reflex: 'sleep' };
  if (person.hunger > GATE.STARVING) return { verdict: 'REFLEX', reflex: 'eat' };
  if (state.weather === 'storm' && !person.conversationId) return { verdict: 'REFLEX', reflex: 'shelter' };

  // beyond survival reflexes, a conversation suppresses escalation/social logic
  // (the LLM is already driving the talk) and any in-progress goal owns the tick
  if (person.conversationId) return { verdict: 'IDLE' };
  if (person.currentGoal && person.currentGoal.until > 0) return { verdict: 'IDLE' };

  // ── escalation triggers (skip while on cooldown) ──
  if (person.gateCooldown <= 0) {
    // 1. fresh high-salience event since we last looked
    const lastMem = person.memories?.[person.memories.length - 1];
    if (lastMem && person.memories.length > person.eventSeen &&
        ['danger', 'death', 'conflict', 'kindness'].includes(lastMem.type)) {
      person.eventSeen = person.memories.length;
      return { verdict: 'ESCALATE' };
    }

    // 2. live relationship conflict with someone nearby
    for (const other of people) {
      if (other.name === person.name || other.alive === false) continue;
      if (distBetween(person, other) > 5) continue;
      const rel = person.relationships[other.name];
      if (!rel) continue;
      if (rel.jealousy > GATE.JEALOUSY_LIVE ||
          rel.stage === RELATIONSHIP_STAGES.RIVAL || rel.stage === RELATIONSHIP_STAGES.ENEMY) {
        return { verdict: 'ESCALATE' };
      }
    }

    // 3. competing desires — two mid-band needs at once, no single reflex answers
    const hungerMid = person.hunger >= GATE.HUNGER_BAND[0] && person.hunger <= GATE.HUNGER_BAND[1];
    const tiredMid = person.tiredness >= GATE.TIRED_BAND[0] && person.tiredness <= GATE.TIRED_BAND[1];
    const lonely = person.loneliness > GATE.LONELY_MID;
    const buildingNeedsWork = person.buildProject && person.buildProject.phase !== 'complete';
    if ((hungerMid && lonely) || (tiredMid && lonely) || (tiredMid && buildingNeedsWork)) {
      return { verdict: 'ESCALATE' };
    }

    // 4. the village is running out of food — a real "do I go help?" choice
    if (totalFood(state) < 20 && totalFood(person) < 5 && Math.random() < 0.1) {
      return { verdict: 'ESCALATE' };
    }

    // 5. a homeless adult wanting shelter — a real survival/comfort choice in ANY
    //    season (everyone wants a home; fall/winter just makes it urgent). Higher
    //    chance as cold approaches so houses actually get built before winter.
    if (!person.home && person.lifeStage === LIFE_STAGES.ADULT && !person.buildProject) {
      const urgency = (state.season === 'fall' || state.season === 'winter') ? 0.12 : 0.06;
      if (Math.random() < urgency) return { verdict: 'ESCALATE' };
    }

    // 6. hungry and hunting has paid off lately → consider a hunt
    if (person.hunger >= GATE.HUNGER_BAND[0] && qValue(person, state, 'hunt') > qValue(person, state, 'forage') &&
        Math.random() < 0.1) {
      return { verdict: 'ESCALATE' };
    }

    // 7. the field is ripe (food just sitting there) or fallow in a growing
    //    season — either is a real "should I go work the field?" decision.
    if (fieldReady(state) && Math.random() < 0.12) {
      return { verdict: 'ESCALATE' };
    }
    if (state.field && !state.field.planted && FARM.GROW_SEASONS.includes(state.season) &&
        totalFood(state) < 25 && Math.random() < 0.04) {
      return { verdict: 'ESCALATE' };
    }

    // 8. IDEATION (Phase 3) — a frustrated, inventive mind who's noticed raw
    //    materials gets the urge to TRY something. Routed to a separate
    //    constrained LLM call (pendingIdea), not the normal action prompt, so we
    //    flag it and let the tick continue with local behavior this turn.
    if (person.ideaCooldown <= 0 && !person.prototype &&
        Object.keys(person.noticedResources || {}).length > 0 &&
        (person.traits?.includes('curious') || person.traits?.includes('creative') || person.traits?.includes('handy')) &&
        pressingNeed(person, state) && Math.random() < IDEA.BASE_CHANCE * (DISCOVERY.RATE_MULT || 1)) {
      person.pendingIdea = true;
    }
  }

  return { verdict: 'IDLE' };
}

// Begin sleeping. If the person has a home they aren't already at, walk there
// FIRST (heading-home state) and only drop into actual sleep on arrival — this is
// what makes a built house get used. Without a home (or already home) they sleep
// in place immediately, as before. The `_sleepWhenHome` flag is consumed by the
// movement block in the main tick when they reach the house.
function beginSleep(person, duration) {
  setGoal(person, 'sleep', null, duration);
  // Only sleep in place when essentially ON the house (within ~0.7 tile). Anything
  // further and they walk all the way home first, so they visibly sleep AT the
  // building rather than a tile or two beside it.
  const nearHome = person.home &&
    Math.abs(person.x - person.home.x) < 0.7 && Math.abs(person.y - person.home.y) < 0.7;
  if (person.home && !nearHome) {
    // head home, awake, then sleep once we arrive
    person._sleepWhenHome = true;
    person.targetX = person.home.x; person.targetY = person.home.y;
    person.activity = 'heading home';
    setEmote(person, 'zzz', 999);
    person.thought = 'Tired — heading home to rest.';
  } else {
    sleepNow(person);
  }
}

// Drop into actual sleep wherever the person currently stands.
function sleepNow(person) {
  // snap exactly onto the home so the sleeper visibly rests inside the building,
  // not a fraction of a tile off-center.
  if (person.home && Math.abs(person.x - person.home.x) < 2 && Math.abs(person.y - person.home.y) < 2) {
    person.x = person.home.x; person.y = person.home.y;
  }
  person.sleeping = true;
  person.activity = 'sleeping';
  person._sleepWhenHome = false;
  person.targetX = null; person.targetY = null;
  person.path = null; person._pathDest = null;
  setEmote(person, 'zzz', 999);
}

// When two villagers pair up, a homeless partner moves into the other's home (and
// joins its owners). If both already have homes, they keep their own — no merge.
function shareHomeWithPartner(a, b) {
  const home = a.home || b.home;
  if (!home) return;
  for (const p of [a, b]) {
    if (!p.home) {
      p.home = home;
      if (home.owners && !home.owners.includes(p.name)) home.owners.push(p.name);
    }
  }
}

// Apply a single-answer reflex locally — no LLM, no discretion.
function applyReflex(person, reflex, state) {
  // survival reflexes are instinctive and break off a conversation: you can't
  // keep chatting when your body is screaming to eat or sleep. The conversation
  // loop sees the cleared conversationId next line and drops this speaker.
  if ((reflex === 'eat' || reflex === 'sleep') && person.conversationId) {
    person._leftConversation = person.conversationId;
    person.conversationId = null;
    person.conversationCooldown = 6 + Math.floor(Math.random() * 6);
  }
  switch (reflex) {
    case 'sleep': {
      beginSleep(person, person.sick ? 200 : 500);
      break;
    }
    case 'eat': {
      const relief = eatFood(person) || takeFromLarder(state, person);
      if (relief > 0) {
        person.eating = true; person.activity = 'eating';
        setEmote(person, 'eat', 30); setGoal(person, 'eat', null, 30);
        rewardAction(person, 'forage', relief / 20, state); // satisfying a need pays off
        break;
      }
      // Nothing on hand or in the larder — go GET food by whatever means. This is
      // instinctive, so we pick the best available producer, not just berries:
      //   1. a ripe field right there → harvest it (free, big yield)
      //   2. hunting if it's paid off lately and there's prey → meat
      //   3. otherwise the nearest food patch (berries / fish), memory-weighted
      if (fieldReady(state)) {
        goToLocation(person, 'Field'); person.activity = 'farming'; setGoal(person, 'farm', 'Field', 120);
        person.thought = 'Starving — the field is ripe, time to harvest.';
        break;
      }
      // hunt only what you can actually SEE — a hungry forager won't magically
      // know where distant game is. processHunting then runs the chase.
      const tooHard = (person.skills?.hunting || 0) < 8;
      const prey = nearestVisiblePrey(person, state, { allowDangerous: !tooHard });
      const huntPays = qValue(person, state, 'hunt') >= qValue(person, state, 'forage');
      if (prey && (huntPays || (person.skills?.hunting || 0) > 5)) {
        person.activity = 'hunting';
        person._huntTargetId = prey.id; person._huntScan = 0;
        person.targetX = prey.x; person.targetY = prey.y;
        person.thought = `Hungry — going after that ${prey.type}.`;
        break;
      }
      const foodLocs = Object.values(LOCATIONS).filter(l => l.type === 'food');
      const loc = weightedLocationPick(person, foodLocs.map(l => l.name));
      if (loc) { goToLocation(person, loc); person.activity = 'gathering'; setGoal(person, 'work', loc, 100); }
      break;
    }
    case 'shelter': {
      if (person.home) { person.targetX = person.home.x; person.targetY = person.home.y; }
      else goToLocation(person, 'Campfire');
      setGoal(person, 'shelter', null, 80);
      break;
    }
  }
}

// Passive generosity: sharing food with a hungry loved one nearby isn't really
// a "decision" — it's an automatic kind act. Runs every tick regardless of the
// gate, preserving the kindness-memory / affection mechanic.
function processFoodSharing(person, people, state) {
  if (person.sleeping || person.eating || totalFood(person) <= 3) return;
  for (const other of people) {
    if (other.name === person.name || other.alive === false || other.hunger < 50) continue;
    if (distBetween(person, other) > 4) continue;
    const rel = person.relationships[other.name];
    if (!rel) continue;
    if (person.partner === other.name || rel.affection > 55 || rel.attraction > 60) {
      // give two units of whatever the giver has most of
      const give = ['meat', 'fish', 'crops', 'berries'].find(t => (person.larder?.[t] || 0) > 0);
      if (!give) break;
      person.larder[give] = Math.max(0, person.larder[give] - 2);
      addFood(other, give, 2);
      other.hunger = clamp(other.hunger - 15, 0, 100);
      setEmote(person, 'heart', 15);
      rel.affection = clamp(rel.affection + 2, 0, 100);
      const otherRel = other.relationships[person.name];
      if (otherRel) otherRel.affection = clamp(otherRel.affection + 3, 0, 100);
      addMemory(other, `${person.name} shared food with me`, 'kindness', state.day, { location: other.currentLocation });
      person.thought = `I gave food to ${other.name}`;
      // a visible kindness — earns a name for generosity (#2)
      bumpReputation(state, person.name, 'generous', 3);
      bumpReputation(state, person.name, 'kind', 1.5);
      break;
    } else if ((other.hunger > 75 && totalFood(person) > 6) && Math.random() < 0.02) {
      // hoarding while a hungry villager stands right there — a name for selfishness
      bumpReputation(state, person.name, 'generous', -2);
      if (other.relationships[person.name]) other.relationships[person.name].affection = clamp(other.relationships[person.name].affection - 1, 0, 100);
      addMemory(other, `${person.name} wouldn't share food while I was starving`, 'conflict', state.day, { location: other.currentLocation });
    }
  }
}

// Phase 7 — barter. When two villagers who aren't close enough to just GIVE meet
// and each holds a surplus the other lacks, they trade ("a copper knife for
// three fish"). This is the seed of an economy: goods move toward who needs them,
// and the exchange builds a little trust. Throttled so it's occasional, not spammy.
const TRADE_GOODS = ['meat', 'fish', 'crops', 'berries', 'copper_ingot', 'flint', 'clay', 'wood', 'stone'];
function holding(p, g) { return (p.larder?.[g] || 0) + (p.inventory?.[g] || 0); }
function moveGood(p, g, n) {
  // prefer pulling from larder for food, inventory for materials
  if ((p.larder?.[g] || 0) >= n) { p.larder[g] -= n; return; }
  if (p.inventory) p.inventory[g] = Math.max(0, (p.inventory[g] || 0) - n);
}
function giveGood(p, g, n) {
  if (['meat', 'fish', 'crops', 'berries'].includes(g)) addFood(p, g, n);
  else if (p.inventory) p.inventory[g] = (p.inventory[g] || 0) + n;
}
function processTrade(person, people, state) {
  if (person.sleeping || person.eating || person.conversationId || Math.random() > 0.01) return;
  for (const other of people) {
    if (other.name === person.name || other.alive === false || other.sleeping) continue;
    if (distBetween(person, other) > 3) continue;
    // what does each have plenty of that the other is short on?
    const mySurplus = TRADE_GOODS.find(g => holding(person, g) >= 4 && holding(other, g) <= 1);
    const theirSurplus = TRADE_GOODS.find(g => g !== mySurplus && holding(other, g) >= 4 && holding(person, g) <= 1);
    if (!mySurplus || !theirSurplus) continue;
    // a simple 2-for-3 style swap
    moveGood(person, mySurplus, 2); giveGood(other, mySurplus, 2);
    moveGood(other, theirSurplus, 3); giveGood(person, theirSurplus, 3);
    const rel = person.relationships[other.name];
    if (rel) rel.trust = clamp(rel.trust + 1.5, 0, 100);
    const orel = other.relationships[person.name];
    if (orel) orel.trust = clamp(orel.trust + 1.5, 0, 100);
    setEmote(person, 'sparkle', 8);
    person.thought = `Traded ${mySurplus} with ${other.name} for some ${theirSurplus}.`;
    addMemory(person, `Traded ${mySurplus} to ${other.name} for ${theirSurplus}.`, 'agreement', state.day, { location: person.currentLocation, valence: 0.5 });
    addMemory(other, `${person.name} traded me ${mySurplus} for ${theirSurplus}.`, 'agreement', state.day, { location: other.currentLocation, valence: 0.5 });
    state.events.push({ day: state.day, hour: state.hour, participants: [person.name, other.name],
      summary: `🤝 ${person.name} and ${other.name} traded ${mySurplus} for ${theirSurplus}.`, type: 'trade' });
    return;
  }
}

function updateMoodFromNeeds(person) {
  if (person.sleeping) return;
  if (person.hunger > 75) { person.mood = 'annoyed'; return; }
  if (person.tiredness > 70) { person.mood = 'anxious'; return; }
  if (person.loneliness > 70) { person.mood = 'lonely'; return; }
  if (person.partner && person.loneliness < 25) {
    if (person.mood === 'neutral') person.mood = 'loving';
  }
  if (person.hunger < 25 && person.tiredness < 35 && person.loneliness < 35) {
    if (person.mood === 'neutral' || person.mood === 'anxious') person.mood = 'content';
  }
}

function updateJealousy(person, people) {
  if (!person.partner) return;
  const partner = people.find(p => p.name === person.partner);
  if (!partner || !partner.conversationId || person.conversationId) return;
  for (const [name, rel] of Object.entries(partner.relationships)) {
    if (name === person.name) continue;
    if (rel.attraction > 55 && rel.familiarity > 20) {
      const myRel = person.relationships[name];
      if (myRel) {
        myRel.jealousy = clamp((myRel.jealousy || 0) + 1, 0, 100);
        if (myRel.jealousy > 40) { setEmote(person, 'jealous', 20); person.mood = 'jealous'; }
      }
    }
  }
}

// ── Life events ──

function processLifeEvents(person, people, state, dayRolled) {
  if (person.partner && person.gender === 'female' && !person.pregnant && person.lifeStage === LIFE_STAGES.ADULT) {
    const partner = people.find(p => p.name === person.partner);
    if (partner) {
      const rel = person.relationships[partner.name];
      if (rel && rel.affection > 70 && rel.stage === RELATIONSHIP_STAGES.DATING) {
        rel.stage = RELATIONSHIP_STAGES.PARTNERED;
        const pRel = partner.relationships[person.name];
        if (pRel) pRel.stage = RELATIONSHIP_STAGES.PARTNERED;
        addMemory(person, `Became partners with ${partner.name}`, 'life', state.day);
        addMemory(partner, `Became partners with ${person.name}`, 'life', state.day);
        state.events.push({ day: state.day, hour: state.hour, participants: [person.name, partner.name], summary: `${person.name} and ${partner.name} became partners!`, type: 'partnership' });
        state.stats.totalPartnerships++;
        setEmote(person, 'heart', 50); setEmote(partner, 'heart', 50);
      }
      // conception is a once-per-day roll, so partners don't breed every tick
      if (dayRolled && rel && rel.stage === RELATIONSHIP_STAGES.PARTNERED && state.day > 3 && Math.random() < CONCEPTION_CHANCE) {
        person.pregnant = true;
        person.pregnancyDay = state.day;            // conceived on this day
        person.pregnancyTimer = Math.max(1, Math.round(TICKS_PER_DAY * GESTATION_DAYS));
        addMemory(person, `Expecting a child with ${partner.name}!`, 'life', state.day);
        addMemory(partner, `${person.name} is expecting our child!`, 'life', state.day);
        setEmote(person, 'sparkle', 40);
        state.events.push({ day: state.day, hour: state.hour, participants: [person.name, partner.name], summary: `${person.name} is expecting!`, type: 'pregnancy' });
      }
    }
  }

  // gestation counts down every tick; the belly bump (renderer) shows throughout
  if (person.pregnant) {
    person.pregnancyTimer--;
    if (person.pregnancyTimer <= 0) {
      person.pregnant = false;
      const partner = people.find(p => p.name === person.partner);
      const baby = spawnChild(person, partner, people, state);
      if (baby) {
        people.push(baby);
        initRelationships(people);
        state.events.push({ day: state.day, hour: state.hour, participants: [person.name, partner?.name, baby.name].filter(Boolean), summary: `${baby.name} was born!`, type: 'birth' });
        state.stats.totalBirths++;
        setEmote(person, 'heart', 50);
        if (partner) setEmote(partner, 'heart', 50);
      }
    }
  }

  // age in step with the calendar: YEARS_PER_DAY years per game-day
  if (dayRolled) {
    person.age += YEARS_PER_DAY;
    person.lifeStage = getLifeStage(person.age);
  }

  // construction progress — work on active build project
  if (person.buildProject && person.buildProject.phase !== 'complete') {
    const bp = person.buildProject;
    const inv = person.inventory;

    // check if they have enough materials
    const mn = bp.materialsNeeded || { wood: 5, stone: 2, thatch: 2 };
    const hasEnough = inv.wood >= mn.wood && inv.stone >= mn.stone && inv.thatch >= mn.thatch;

    if (hasEnough && distBetween(person, { x: bp.site.x, y: bp.site.y }) < 3) {
      // at build site with materials — advance construction (proximity to the
      // site is what matters, not the named location under their feet)
      bp.progress = (bp.progress || 0) + 2 + (person.skills.building || 0) * 0.04;
      person.activity = 'building';
      gainSkill(person, 'building', 0.05);
      rewardAction(person, 'build', 0.4, state); // steady progress is rewarding

      const totalNeeded = mn.wood + mn.stone + mn.thatch;
      const progressTarget = totalNeeded * 1.5; // faster so houses actually finish

      if (bp.progress >= progressTarget) {
        // construction complete!
        inv.wood -= mn.wood;
        inv.stone -= mn.stone;
        inv.thatch -= mn.thatch;
        bp.phase = 'complete';

        const home = {
          x: bp.site.x, y: bp.site.y,
          owners: [person.name, person.partner].filter(Boolean),
          type: bp.type || 'shelter',
          description: bp.description || '',
          quality: bp.quality || 'basic',
        };
        person.home = home;
        const partner = person.partner ? people.find(p => p.name === person.partner) : null;
        if (partner) partner.home = home;
        state.buildings.push(home);

        setEmote(person, 'sparkle', 60);
        gainSkill(person, 'building', 3);
        rewardAction(person, 'build', 10, state); // big payoff: Q learns building is worth it
        addMemory(person, `Finished building a ${bp.type}${partner ? ` with ${partner.name}` : ''}!`, 'achievement', state.day, { location: person.currentLocation });
        state.events.push({ day: state.day, hour: state.hour, participants: [person.name, partner?.name].filter(Boolean), summary: `🏠 ${person.name} completed a ${bp.type}!`, type: 'building' });
        // OTHERS NOTICE: villagers nearby witness the new building — they form a
        // memory of it, admire the builder (awe + relationship), and the builder's
        // "skilled" reputation grows. A finished house is a real social event.
        bumpReputation(state, person.name, 'skilled', 3);
        const WITNESS_RADIUS = 10;
        for (const o of people) {
          if (o.alive === false || o.isAvatar || o.name === person.name || o.name === partner?.name) continue;
          if (distBetween(o, home) > WITNESS_RADIUS) continue;
          addMemory(o, `Saw ${person.name} finish building a ${bp.type}.`, 'event', state.day,
            { location: o.currentLocation, valence: 0.8 });
          const rel = o.relationships[person.name];
          if (rel) { rel.affection = clamp(rel.affection + 3, 0, 100); rel.familiarity = clamp(rel.familiarity + 2, 0, 100); }
          setEmote(o, 'sparkle', 14);
        }
        person.buildProject = null;
      } else {
        // show phases
        const pct = bp.progress / progressTarget;
        if (pct < 0.33) bp.phase = 'foundation';
        else if (pct < 0.66) bp.phase = 'walls';
        else bp.phase = 'roof';
      }
    } else if (!hasEnough) {
      // need to gather — go to resource location
      if (inv.wood < mn.wood && !person.currentGoal) {
        goToLocation(person, 'Grove');
        person.activity = 'chopping';
        person.thought = `Need ${mn.wood - inv.wood} more wood for the ${bp.type}`;
        setGoal(person, 'chop_wood', 'Grove', 80);
      } else if (inv.stone < mn.stone && !person.currentGoal) {
        goToLocation(person, 'Rock Seat');
        person.activity = 'collecting';
        person.thought = `Need ${mn.stone - inv.stone} more stone`;
        setGoal(person, 'collect_stone', 'Rock Seat', 80);
      } else if (inv.thatch < mn.thatch && !person.currentGoal) {
        goToLocation(person, 'Meadow');
        person.activity = 'gathering';
        person.thought = `Need ${mn.thatch - inv.thatch} more thatch`;
        setGoal(person, 'gather_thatch', 'Meadow', 80);
      }
    } else if (!person.currentGoal) {
      // have materials, go to build site
      person.targetX = bp.site.x;
      person.targetY = bp.site.y;
      person.activity = 'building';
      setGoal(person, 'build', null, 40);
    }
  }
}

function spawnChild(mother, father, people, state) {
  const gender = Math.random() < 0.5 ? 'male' : 'female';
  const names = CHILD_NAMES[gender];
  const usedNames = new Set(people.map(p => p.name));
  const available = names.filter(n => !usedNames.has(n));
  if (!available.length) return null;
  const name = available[Math.floor(Math.random() * available.length)];
  const allTraits = [...mother.traits, ...(father?.traits || ['curious'])];
  const traits = [];
  const pool = [...allTraits];
  while (traits.length < 4 && pool.length) {
    const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    if (!traits.includes(pick)) traits.push(pick);
  }
  const mc = mother.color, fc = father ? father.color : 0xaaaaaa;
  const color = (((mc >> 16 & 0xFF) + (fc >> 16 & 0xFF)) >> 1) << 16 |
                (((mc >> 8 & 0xFF) + (fc >> 8 & 0xFF)) >> 1) << 8 |
                (((mc & 0xFF) + (fc & 0xFF)) >> 1);
  const child = initPerson({
    name, gender, age: 0, color, traits,
    values: Math.random() < 0.5 ? mother.values : (father?.values || ['curiosity']),
    quirks: 'babbles, cries when hungry', background: `Child of ${mother.name} and ${father?.name || 'unknown'}.`,
    speechStyle: 'baby sounds', parents: [mother.name, father?.name].filter(Boolean), children: [],
    // a child "learns to speak" with a parent's model (its inherited voice)
    model: Math.random() < 0.5 ? mother.model : (father?.model || mother.model),
  }, nextPersonId++, mother.x, mother.y);
  child.parents = [mother.name, father?.name].filter(Boolean);
  mother.children.push(name);
  if (father) father.children.push(name);
  // a child is born into its parents' home (if either has one), not homeless
  const parentHome = mother.home || father?.home || null;
  if (parentHome) {
    child.home = parentHome;
    if (parentHome.owners && !parentHome.owners.includes(name)) parentHome.owners.push(name);
  }
  addMemory(mother, `Gave birth to ${name}`, 'life', state.day);
  if (father) addMemory(father, `${name} was born`, 'life', state.day);
  return child;
}

// ── Main tick ──

export function simulateTick(state) {
  if (state.paused) return state;
  // Shallow clone ONLY. The engine deliberately keeps person (and wildlife/etc.)
  // objects STABLE across ticks: async flows like runConversation/runAIAction/
  // avatarSpeak capture a person reference and mutate it many ticks later (set/
  // clear conversationId, apply AI-decided mood/goals). Deep-cloning people every
  // tick orphans those captured references — e.g. a conversation would clear the
  // lock on a stale copy while the live clone stayed frozen forever. So the tick
  // mutates the existing objects in place by design; the snapshot identity that
  // changes each tick is the top-level `next`, which is enough for React/render.
  const next = { ...state, tick: state.tick + 1 };

  // 1 game-minute per tick. At 400ms tick interval, 1 day = 1440 ticks = ~9.6 real minutes
  let dayRolled = false;
  next.minute += 1;
  if (next.minute >= 60) {
    next.minute = 0; next.hour++;
    if (next.hour >= 24) { next.hour = 0; next.day++; dayRolled = true;
      next.weather = Math.random() < 0.25 ? 'rainy' : Math.random() < 0.15 ? 'cloudy' : 'clear';
    }
  }
  next.timeOfDay = getTimeOfDay(next.hour);

  // The god avatar lives in `people` so it renders and can be perceived/talked
  // to, but it is NOT an autonomous villager: exclude it from the simulation
  // loops (no hunger, aging, death, escalation, matchmaking, etc.).
  const alivePeople = next.people.filter(p => p.alive !== false && !p.isAvatar);

  for (const person of next.people) {
    if (person.alive === false) continue;
    if (person.isAvatar) continue; // god-controlled — skip all autonomous processing

    if (person.conversationCooldown > 0) person.conversationCooldown--;
    if (person.actionCooldown > 0) person.actionCooldown--;
    if (person.gateCooldown > 0) person.gateCooldown--;
    if (person.emoteTimer > 0) { person.emoteTimer--; if (person.emoteTimer <= 0) person.emote = null; }
    if (person.currentGoal) {
      person.currentGoal.until--;
      if (person.currentGoal.until <= 0) person.currentGoal = null;
      // early completion: clear the goal the moment it's actually accomplished,
      // instead of waiting out the timer (see goals.js).
      else clearCompletedGoal(person, next);
    }

    updateNeeds(person, next.timeOfDay, next.weather);
    updateMoodFromNeeds(person);
    updateJealousy(person, alivePeople);
    updateSkills(person, next);
    // continuous active pursuit — runs every tick a person is hunting, chasing
    // the prey's LIVE position via vision. Independent of the goal lock so it
    // actually completes (the old one-shot hunt never could).
    processHunting(person, next);
    // ── invention/tech (Phases 1,4,5) ──
    processDiscovery(person, next);        // notice hidden resources nearby
    processPrototype(person, next);        // advance an in-progress experiment
    processTechObservation(person, next);  // learn by watching someone use a tech
    if (person.ideaCooldown > 0) person.ideaCooldown--;
    if (dayRolled) decayMemories(person, next);
    processBreakups(person, alivePeople, next);
    processIllness(person, next);
    processGrief(person);
    processAmbitions(person, next);
    processPersonalityConflict(person, alivePeople, next);
    processFrailty(person, alivePeople, next, dayRolled);
    processAdultTeaching(person, alivePeople, next);

    for (const otherName of Object.keys(person.relationships))
      updateRelationshipStage(person, otherName, alivePeople);

    processLifeEvents(person, next.people, next, dayRolled);
    processDeath(person, next);

    // children learn from nearby parents
    if ((person.lifeStage === LIFE_STAGES.CHILD || person.lifeStage === LIFE_STAGES.TEEN) && person.parents.length) {
      const parent = alivePeople.find(p => person.parents.includes(p.name) && distBetween(person, p) < 5);
      if (parent) childLearnFromParent(person, parent);
    }

    // favorite location — set after visiting
    if (!person.favoriteLocation && person.currentLocation !== 'village' && Math.random() < 0.01) {
      person.favoriteLocation = person.currentLocation;
    }

    // babies/toddlers follow parents
    if (person.lifeStage === LIFE_STAGES.BABY || (person.lifeStage === LIFE_STAGES.CHILD && person.age < 6)) {
      const parent = alivePeople.find(p => person.parents.includes(p.name));
      if (parent) {
        person.x += (parent.x - person.x) * 0.08;
        person.y += (parent.y - person.y) * 0.08;
        person.currentLocation = parent.currentLocation;
      }
      continue;
    }

    // children play together or follow parents
    if (person.lifeStage === LIFE_STAGES.CHILD) {
      const otherKids = alivePeople.filter(p => p.lifeStage === LIFE_STAGES.CHILD && p.name !== person.name);
      if (otherKids.length && Math.random() < 0.02 && !person.targetX) {
        const playmate = otherKids[Math.floor(Math.random() * otherKids.length)];
        goToPerson(person, playmate);
        person.activity = 'playing';
        setGoal(person, 'play', playmate.name, 20);
      } else if (!person.targetX && Math.random() < 0.03) {
        const parent = alivePeople.find(p => person.parents.includes(p.name));
        if (parent) goToPerson(person, parent);
      }
    }

    // teens rebel — sometimes refuse to go where expected
    if (person.lifeStage === LIFE_STAGES.TEEN && person.currentGoal?.type === 'work' && Math.random() < 0.15) {
      pickExploreTarget(person);
      person.mood = 'annoyed';
      person.thought = "I don't want to work right now...";
    }

    if (person.conversationId) continue;
    if (person.sleeping) continue;
    // heading home to sleep, but the sleep urge lapsed (goal expired) before
    // arriving — don't wander off mid-trip; just sleep where they are.
    if (person._sleepWhenHome && (!person.currentGoal || person.currentGoal.type !== 'sleep')) {
      sleepNow(person);
      person.currentLocation = locationAt(person.x, person.y);
      continue;
    }
    if (person.eating) {
      const curLoc = locationAt(person.x, person.y);
      const foodLocs = Object.values(LOCATIONS).filter(l => l.type === 'food');
      if (!foodLocs.some(l => l.name === curLoc) && person.targetX === null) person.eating = false;
      continue;
    }

    processFoodSharing(person, alivePeople, next);
    processTrade(person, alivePeople, next);       // Phase 7: barter surpluses

    const gate = escalationGate(person, alivePeople, next);
    if (gate.verdict === 'REFLEX') {
      applyReflex(person, gate.reflex, next);
    } else if (gate.verdict === 'ESCALATE') {
      person.pendingLLM = true; // the AI interval will pick this person up
      // leave the slot open for the LLM — don't run the local schedule this tick
    }

    // an active hunter already moved itself this tick (processHunting chases the
    // live prey position); don't double-move it here. A survival reflex above can
    // still flip activity away from 'hunting' and reclaim control.
    if (person.activity === 'hunting' && gate.verdict !== 'REFLEX') {
      person.currentLocation = locationAt(person.x, person.y);
      continue;
    }

    if (person.targetX !== null) {
      const arrived = moveToward(person, person.targetX, person.targetY, next);
      if (arrived) {
        person.currentLocation = locationAt(person.x, person.y);
        person.idle = 0;
        // reached home while heading there to sleep → now actually sleep
        if (person._sleepWhenHome) { sleepNow(person); person.currentLocation = locationAt(person.x, person.y); continue; }
        // opportunistic auto-eat on arrival — but NOT while in a conversation
        // (that would silently pull them out and kill the dialogue after 1 line)
        if (person.hunger > 40 && !person.conversationId) {
          const foodLocs = Object.values(LOCATIONS).filter(l => l.type === 'food');
          if (foodLocs.some(l => l.name === person.currentLocation)) {
            person.eating = true; person.activity = 'eating';
            setEmote(person, 'eat', 20); setGoal(person, 'eat', null, 25);
          }
        }
      }
    } else if (gate.verdict === 'IDLE') {
      person.idle++;
      if (person.idle > 8) { pickTarget(person, alivePeople, next); person.idle = 0; }
    }

    person.currentLocation = locationAt(person.x, person.y);
  }

  // ambient events
  processAmbientEvents(next);

  // seasonal events
  processSeasonalEvents(next);

  // season and resources
  updateSeason(next);
  processResources(next, dayRolled);

  // wildlife
  updateWildlife(next);

  return next;
}

// ── Skills (with gameplay effects) ──

// pick the tool a person would most benefit from: matches a needed gathering
// skill they don't already have a tool for.
function chooseToolToCraft(person) {
  const tools = person.tools || {};
  const options = [
    { tool: 'fishing_rod', skill: 'fishing' },
    { tool: 'axe', skill: 'building' },
    { tool: 'forage_basket', skill: 'foraging' },
  ].filter(o => !tools[o.tool]);
  if (!options.length) return 'fishing_rod'; // already has all; remake the first
  // favor the skill they use most (highest), so the tool pays off
  options.sort((a, b) => (person.skills[b.skill] || 0) - (person.skills[a.skill] || 0));
  return options[0].tool;
}

// Skill grows from SUCCESS, not from time spent standing around. A productive
// yield is what teaches you — so a focused hunter/forager genuinely outpaces a
// chatterbox, and skills diverge into specialists.
const SKILL_GAIN_ON_SUCCESS = 0.15;
function gainSkill(person, skill, amount = SKILL_GAIN_ON_SUCCESS) {
  person.skills[skill] = Math.min(100, (person.skills[skill] || 0) + amount);
}

// ── Typed food economy ──

// ════════════════════════════════════════════════════════════════════════════
// INVENTION & TECH  (Phases 1-5, 7)
//
// The agents never see the tech graph. They notice raw materials they're near,
// the LLM ideates freely from what they've personally seen, and the SYSTEM maps
// that idea onto the hidden DAG, validates prerequisites, and runs a multi-tick
// prototyping loop where failure is productive. Knowledge then spreads by
// observation and teaching, and dies with its holder unless it was passed on.
// ════════════════════════════════════════════════════════════════════════════

// Does this person have a "pressing need" sharp enough to make them inventive?
// Frustration is the mother of invention: a tired builder eyeing hard rocks, a
// hungry farmer wishing the soil turned easier. Returns a short phrase or null.
function pressingNeed(person, state) {
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
function processDiscovery(person, state) {
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
function attemptableTech(person, state, tech) {
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
function processPrototype(person, state) {
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
function processTechObservation(person, state) {
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

function updateSkills(person, state) {
  const loc = person.currentLocation;
  const tools = person.tools || {};

  const season = SEASON_ABUNDANCE[state.season] || { forage: 1, hunt: 1 };
  // food gathering — skill advances only on a successful yield
  if (person.activity === 'working' || person.activity === 'gathering') {
    if (loc === 'Fishing Spot') {
      const chance = (0.015 + person.skills.fishing * 0.0005) * (tools.fishing_rod ? 1.6 : 1) * patchYield(state, 'Fishing Spot');
      if (Math.random() < chance) {
        const amount = 1 + Math.floor(person.skills.fishing / 25);
        addFood(person, 'fish', amount);
        person.foodGathered += amount;
        gainSkill(person, 'fishing');
        depletePatch(state, 'Fishing Spot');
        rewardAction(person, 'fish', amount, state);
        person.thought = `Caught ${amount} fish!`;
      }
    } else if (loc === 'Berry Bush') {
      const chance = (0.015 + person.skills.foraging * 0.0005) * (tools.forage_basket ? 1.6 : 1) * patchYield(state, 'Berry Bush') * season.forage;
      if (Math.random() < chance) {
        const amount = 1 + Math.floor(person.skills.foraging / 25);
        addFood(person, 'berries', amount);
        person.foodGathered += amount;
        gainSkill(person, 'foraging');
        depletePatch(state, 'Berry Bush');
        rewardAction(person, 'forage', amount, state);
        person.thought = `Found ${amount} berries!`;
      }
    }
  }

  // chopping wood at Grove — depletes the grove (visibly thins) and regrows slowly
  if ((person.activity === 'chopping' || person.activity === 'working') && loc === 'Grove') {
    if (Math.random() < (0.012 + person.skills.building * 0.0004) * (tools.axe ? 1.6 : 1) * patchYield(state, 'Grove')) {
      person.inventory.wood++;
      gainSkill(person, 'building');
      depleteGrove(state);
      rewardAction(person, 'chop_wood', 1, state);
      person.thought = `Chopped a log! (${person.inventory.wood} total)`;
      setEmote(person, 'sparkle', 8);
    }
  }

  // farming at the Field — sow / tend / harvest depending on field state. This
  // is the one productive action with a multi-day payoff: you sow, it grows over
  // days (only in growing seasons), you tend it to speed it, then harvest crops.
  if ((person.activity === 'farming' || person.activity === 'working') && loc === 'Field') {
    const f = state.field || (state.field = { planted: false, stage: 0, plantedDay: null });
    if (!f.planted) {
      // sow the fallow field — quick, but futile in winter (Q will learn this)
      f.planted = true;
      f.stage = 0;
      f.plantedDay = state.day;
      gainSkill(person, 'farming', 0.1);
      const winter = !FARM.GROW_SEASONS.includes(state.season);
      rewardAction(person, 'farm', winter ? -1 : 1, state); // sowing into frost rarely pays
      person.thought = winter ? 'Sowing now, in winter? Nothing will grow...' : 'Sowed the field. Now to wait for it to grow.';
      setEmote(person, 'sparkle', 6);
    } else if (f.stage >= FARM.RIPE) {
      // harvest! big typed-crop yield scaled by farming skill, boosted by any
      // farming tech the village has invented (plow / irrigation — Phase 4).
      const yield_ = Math.round((FARM.BASE_YIELD + person.skills.farming * FARM.SKILL_YIELD) * (state.farmYieldMult ?? 1));
      addFood(person, 'crops', yield_);
      person.foodGathered += yield_;
      gainSkill(person, 'farming', 1);
      rewardAction(person, 'farm', yield_, state);
      addMemory(person, `Harvested ${yield_} crops from the field!`, 'achievement', state.day, { location: 'Field' });
      state.events.push({ day: state.day, hour: state.hour, participants: [person.name], summary: `🌾 ${person.name} harvested the field!`, type: 'harvest' });
      bumpReputation(state, person.name, 'skilled', 2);
      bumpReputation(state, person.name, 'generous', 1); // feeds the village
      setEmote(person, 'sparkle', 20);
      person.thought = `Harvested ${yield_} crops!`;
      f.planted = false; f.stage = 0; f.plantedDay = null; // back to fallow
    } else if (Math.random() < 0.05) {
      // tend the growing crop — nudges it toward ripe, small skill + reward
      f.stage = Math.min(FARM.RIPE, f.stage + FARM.TEND_GAIN);
      gainSkill(person, 'farming', 0.08);
      rewardAction(person, 'farm', 0.5, state);
      person.thought = `Tending the crops (${Math.round(f.stage * 100)}% grown).`;
    }
  }

  // crafting a tool — progresses while activity is 'crafting'; faster with skill
  if (person.activity === 'crafting' && person.craftTool) {
    person.craftProgress = (person.craftProgress || 0) + 1 + person.skills.crafting * 0.02;
    if (person.craftProgress >= 40) {
      person.tools = { ...(person.tools || {}), [person.craftTool]: true };
      gainSkill(person, 'crafting', 1);
      const made = person.craftTool.replace('_', ' ');
      person.thought = `Finished crafting a ${made}!`;
      setEmote(person, 'sparkle', 12);
      addMemory(person, `Crafted a ${made}`, 'achievement', person._craftDay ?? 0, { location: person.currentLocation });
      rewardAction(person, 'craft', 3, state);
      person.craftTool = null;
      person.craftProgress = 0;
      person.activity = 'idle';
    }
  }

  // collecting stone at Rock Seat
  if ((person.activity === 'collecting' || person.activity === 'working') && loc === 'Rock Seat') {
    if (Math.random() < 0.01 + person.skills.building * 0.0004) {
      person.inventory.stone++;
      gainSkill(person, 'building');
      rewardAction(person, 'collect_stone', 1, state);
      person.thought = `Found a good stone! (${person.inventory.stone} total)`;
    }
  }

  // gathering thatch at Meadow
  if ((person.activity === 'gathering' || person.activity === 'working') && loc === 'Meadow') {
    if (Math.random() < (0.015 + person.skills.foraging * 0.0005) * (tools.forage_basket ? 1.6 : 1)) {
      person.inventory.thatch++;
      gainSkill(person, 'foraging', 0.08);
      rewardAction(person, 'gather_thatch', 1, state);
      person.thought = `Gathered thatch! (${person.inventory.thatch} total)`;
    }
  }

  // mining a noticed raw material (Phase 1→2). When seeking a material they've
  // spotted, standing on/near its node yields it so prototyping can proceed.
  if ((person.activity === 'mining' || person.currentGoal?.type === 'seek_material')) {
    const want = person.currentGoal?.target;
    const node = (state.resourceNodes || []).find(n =>
      n.material === want && person.noticedResources?.[n.material] &&
      Math.hypot(person.x - n.x, person.y - n.y) <= DISCOVERY.RANGE);
    if (node) {
      person.activity = 'mining';
      if (Math.random() < 0.02 + (person.skills.building || 0) * 0.0004) {
        person.inventory[want] = (person.inventory[want] || 0) + 1;
        gainSkill(person, 'building', 0.08);
        person.thought = `Gathered some ${want}. (${person.inventory[want]} total)`;
        setEmote(person, 'sparkle', 6);
        if ((person.inventory[want] || 0) >= 2) person.currentGoal = null; // enough to try with
      }
    }
  }

  // storytelling is now a modest, completion-based skill (handled at end of a
  // conversation in runConversation), NOT a free +0.06/tick ride. Here we only
  // keep the subtle attraction effect for already-skilled storytellers.
  if (person.conversationId && person.skills.storytelling > 30) {
    for (const rel of Object.values(person.relationships)) {
      if (rel.familiarity > 10 && Math.random() < 0.005) {
        rel.attraction = Math.min(100, rel.attraction + 0.3);
      }
    }
  }

  // children learn from nearby parents
  if ((person.lifeStage === LIFE_STAGES.CHILD || person.lifeStage === LIFE_STAGES.TEEN) && person.parents.length) {
    // no direct people array access here — handled in main tick
  }
}

function childLearnFromParent(child, parent) {
  // children slowly inherit skills from parents
  for (const skill of Object.keys(child.skills)) {
    if (parent.skills[skill] > 10 && child.skills[skill] < parent.skills[skill] * 0.8) {
      child.skills[skill] = Math.min(100, child.skills[skill] + 0.03);
    }
  }
}

// ── Adult skill transfer (#7) ──
// Knowledge spreads between grown villagers, not just parent→child. When a novice
// lingers near a clear expert, the novice drifts upward in that skill — a slow,
// ambient apprenticeship. Occasionally it sparks an explicit teaching exchange
// (flagged here, run as an LLM beat by the conversation system).
function processAdultTeaching(person, people, state) {
  if (person.alive === false || person.sleeping || person.conversationId) return;
  if (person.lifeStage === LIFE_STAGES.BABY || person.lifeStage === LIFE_STAGES.CHILD) return;
  const mySkill = topSkill(person);
  const myTech = Object.keys(person.knownTech || {});
  if ((!mySkill || (person.skills[mySkill] || 0) < 25) && !myTech.length) return; // expert in skill OR tech
  for (const other of people) {
    if (other === person || other.alive === false || other.sleeping) continue;
    if (other.lifeStage === LIFE_STAGES.BABY) continue;
    if (distBetween(person, other) > 3) continue;
    // ── Phase 5: teach a RECIPE the novice lacks but could do (oral tradition) ──
    if (state && !person._pendingTechTeach && person.conversationCooldown <= 0) {
      const teachable = myTech.find(t => !other.knownTech?.[t] && attemptableTech(other, state, recipeFor(state, t)));
      if (teachable && Math.random() < 0.004) {
        person._pendingTechTeach = { student: other.name, techId: teachable };
        continue;
      }
    }
    if (mySkill && (person.skills[mySkill] || 0) >= 25) {
      const gap = (person.skills[mySkill] || 0) - (other.skills[mySkill] || 0);
      if (gap < 15) continue; // only worth teaching a clear novice
      // ambient drift — the novice picks a little up just by being around mastery
      other.skills[mySkill] = Math.min(100, (other.skills[mySkill] || 0) + 0.02);
      // occasionally escalate to an explicit lesson (handled as a conversation beat)
      if (!person._pendingTeach && person.conversationCooldown <= 0 && Math.random() < 0.0008) {
        person._pendingTeach = { student: other.name, skill: mySkill };
      }
    }
  }
}

// ── Illness ──

function processIllness(person, state) {
  if (person.alive === false) return;

  // sick people recover over time
  if (person.sick) {
    person.sickTimer--;
    person.tiredness = Math.min(100, person.tiredness + 0.3);
    person.hunger = Math.min(100, person.hunger + 0.1);

    // seek out the village's best healer rather than suffering alone (#5)
    const healer = bestSpecialist(state.people, 'healing', person);
    if (healer && !person.currentGoal && distBetween(person, healer) > 3 && !healer.sleeping) {
      goToPerson(person, healer);
      person.activity = 'seeking';
      setGoal(person, 'seek_healer', healer.name, 30);
      person.thought = `I should find ${healer.name} — they know healing.`;
    }
    if (person.sickTimer <= 0) {
      person.sick = false;
      person.mood = 'content';
      addMemory(person, 'Recovered from illness', 'life', state.day, { location: person.currentLocation });
    }
    // healer nearby can speed recovery — and earns a name for it (#2/#5)
    const alivePeople = state.people.filter(p => p.alive !== false && p.name !== person.name);
    for (const p of alivePeople) {
      if (p.skills.healing > 20 && distBetween(person, p) < 4) {
        person.sickTimer = Math.max(0, person.sickTimer - 1);
        p.skills.healing = Math.min(100, p.skills.healing + 0.15);
        if (!p.currentGoal) {
          p.activity = 'healing';
          setGoal(p, 'heal', person.name, 15);
        }
        if (Math.random() < 0.01) {
          bumpReputation(state, p.name, 'kind', 2);
          bumpReputation(state, p.name, 'skilled', 1);
          const sr = person.relationships[p.name];
          if (sr) { sr.affection = clamp(sr.affection + 1, 0, 100); sr.trust = clamp(sr.trust + 1, 0, 100); }
        }
      }
    }
    // severe illness erodes health rather than flipping a kill switch — the
    // decline shows up first (frail, achy, slow) and processDeath finishes it (#10)
    if (person.hunger > 90) person.health = clamp((person.health ?? 100) - 0.05, 0, 100);
    return;
  }

  // natural illness — more likely when hungry, tired, or in winter; a home
  // (shelter) cuts the risk, especially in winter
  const winterMod = state.season === 'winter' ? 3 : 1;
  const exhaustionMod = person.tiredness > 70 ? 2 : 1;
  const hungerMod = person.hunger > 60 ? 2 : 1;
  const shelterMod = person.home ? 0.5 : 1;
  if (Math.random() < 0.00004 * winterMod * exhaustionMod * hungerMod * shelterMod) {
    person.sick = true;
    person.sickTimer = 200 + Math.floor(Math.random() * 200); // ~3-7 game-hours
    person.mood = 'sad';
    setEmote(person, 'sick', 30);
    addMemory(person, 'Fell ill', 'life', state.day, { valence: -1, location: person.currentLocation });
    state.events.push({ day: state.day, hour: state.hour, participants: [person.name], summary: `${person.name} has fallen ill.`, type: 'illness' });
  }
}

// ── Grief ──

function processGrief(person) {
  if (person.griefTimer > 0) {
    person.griefTimer--;
    if (person.griefTimer % 20 === 0) {
      person.mood = 'sad';
      setEmote(person, 'tear', 10);
    }
    // grief affects needs
    person.loneliness = Math.min(100, person.loneliness + 0.1);
    person.hunger = Math.min(100, person.hunger + 0.05); // loss of appetite, slower eating
  }
}

// ── Ambitions ──

function processAmbitions(person, state) {
  if (!person.ambitions) return;
  for (const a of person.ambitions) {
    if (a.completed) continue;
    // `check` is a function lost across JSON save/load — rehydrated by migrateState,
    // but guard anyway so a stray serialized ambition never crashes the tick.
    if (typeof a.check === 'function' && a.check(person)) {
      a.completed = true;
      person.mood = 'excited';
      setEmote(person, 'sparkle', 40);
      addMemory(person, `Achieved ambition: ${a.label}!`, 'ambition', state.day);
      state.events.push({ day: state.day, hour: state.hour, participants: [person.name], summary: `⭐ ${person.name} achieved: ${a.label}!`, type: 'ambition' });
    }
  }
}

// ── Season ──

function updateSeason(state) {
  // season changes every 7 days
  const seasons = ['spring', 'summer', 'fall', 'winter'];
  const seasonIdx = Math.floor((state.day - 1) / 7) % 4;
  const newSeason = seasons[seasonIdx];
  if (state.season !== newSeason) {
    state.season = newSeason;
    state.events.push({ day: state.day, hour: state.hour, participants: [], summary: `🍃 ${newSeason.charAt(0).toUpperCase() + newSeason.slice(1)} has arrived.`, type: 'seasonal' });
  }
}

// ── Village resources ──

function processResources(state, dayRolled) {
  // gatherers periodically deposit surplus food into the shared larder
  if (state.tick % 200 === 0) {
    for (const p of state.people) {
      if (p.alive === false || !p.larder) continue;
      for (const t of Object.keys(FOOD_TYPES)) {
        const surplus = (p.larder[t] || 0) - 4; // keep a personal reserve of 4
        if (surplus > 0) { p.larder[t] -= surplus; state.larder[t] = (state.larder[t] || 0) + surplus; }
      }
    }
  }
  // village consumes from the larder (most-abundant type) per person, ~4 game-hrs
  if (state.tick % 250 === 0) {
    const alive = state.people.filter(p => p.alive !== false).length;
    for (let i = 0; i < alive; i++) {
      let best = null, max = 0;
      for (const t of Object.keys(FOOD_TYPES)) if ((state.larder[t] || 0) > max) { max = state.larder[t]; best = t; }
      if (best) state.larder[best]--;
    }
  }
  // spoilage: a fraction of each food type rots per game-day (a smokehouse can
  // slow this later via System 4)
  if (dayRolled) {
    // daily discovery-metrics heartbeat — one line per game-day so the log shows
    // rates over time (experiments/day, success rate, what's blocking ideas).
    simlog('metrics', summarizeTech(state), `Day ${state.day} tech summary`);
    const buildingSlow = (state.buildings || []).some(b => /smokehouse|storage|drying/i.test(b.type || '')) ? 0.5 : 1;
    // invented preservation tech (pottery/drying rack/smokehouse) compounds with
    // any storage building, via the spoilageMult set in applyTechEffect.
    const slow = buildingSlow * (state.spoilageMult ?? 1);
    for (const t of Object.keys(FOOD_TYPES)) {
      const rot = Math.floor((state.larder[t] || 0) * FOOD_TYPES[t].spoilPerDay * slow);
      if (rot > 0) state.larder[t] = Math.max(0, state.larder[t] - rot);
    }
    regrowPatches(state);
    growField(state);
    updatePond(state);
    decayReputation(state);
    reassignFlakyModels(state);
  }
  // famine: empty larder makes everyone hungrier faster
  if (totalFood(state) <= 0) {
    for (const p of state.people) {
      if (p.alive !== false) p.hunger = Math.min(100, p.hunger + 0.5);
    }
  }
}

// ── Personality conflict ──

function processPersonalityConflict(person, people, state) {
  if (person.conversationId || person.conversationCooldown > 0) return;
  // check for personality clashes with nearby people
  for (const other of people) {
    if (other.name === person.name || other.alive === false) continue;
    if (distBetween(person, other) > 5) continue;
    const rel = person.relationships[other.name];
    if (!rel || rel.familiarity < 15) continue;

    // personality clash: bold vs quiet, restless vs loyal
    const clashTraits = [['bold', 'quiet'], ['restless', 'loyal'], ['opinionated', 'evasive'], ['passionate', 'practical']];
    let clashScore = 0;
    for (const [a, b] of clashTraits) {
      if (person.traits.includes(a) && other.traits.includes(b)) clashScore++;
      if (person.traits.includes(b) && other.traits.includes(a)) clashScore++;
    }
    // accumulated emotional history with this person colors the odds:
    // a bad history makes clashes likelier, a good one dampens them.
    const pv = personValence(person, other.name);
    const clashMod = pv < -2 ? 1.6 : pv > 2 ? 0.5 : 1;
    if (clashScore > 0 && Math.random() < 0.0002 * clashScore * clashMod) {
      // trigger a disagreement
      rel.trust = Math.max(0, rel.trust - 3);
      rel.affection = Math.max(0, rel.affection - 2);
      person.mood = 'annoyed';
      setEmote(person, 'anger', 15);
      addMemory(person, `Had a disagreement with ${other.name}`, 'conflict', state.day, { location: person.currentLocation });
      state.events.push({ day: state.day, hour: state.hour, participants: [person.name, other.name], summary: `${person.name} and ${other.name} had a personality clash.`, type: 'conflict' });
    }

    // value conflict
    const sharedValues = person.values.filter(v => other.values.includes(v)).length;
    if (sharedValues === 0 && rel.familiarity > 25 && Math.random() < 0.0001) {
      rel.trust = Math.max(0, rel.trust - 2);
      addMemory(person, `Disagrees with ${other.name}'s values`, 'conflict', state.day, { location: person.currentLocation });
    }

    // reconciliation — high trust can repair, and fond history makes it likelier
    if (rel.stage === RELATIONSHIP_STAGES.RIVAL && rel.trust > 40 && Math.random() < 0.005 * (pv > 2 ? 2 : 1)) {
      rel.stage = RELATIONSHIP_STAGES.ACQUAINTANCE;
      rel.affection = Math.min(100, rel.affection + 10);
      addMemory(person, `Made amends with ${other.name}`, 'life', state.day);
      state.events.push({ day: state.day, hour: state.hour, participants: [person.name, other.name], summary: `${person.name} and ${other.name} reconciled.`, type: 'reconciliation' });
    }
  }
}

// ── Frailty, injury & health — give death a lead-up (#10) ──
// Elders slowly grow frail (slower, achier); injuries heal over days, faster if
// a healer is near; sustained hunger and frailty erode `health`, which is what
// processDeath now reads. The effective movement speed reflects both.
function effectiveSpeed(person) {
  const base = person._baseSpeed ?? person.speed ?? 0.4;
  const frailMul = 1 - Math.min(1, (person.frailty || 0) / 100) * FRAILTY_SPEED_PENALTY;
  const injMul = 1 - Math.min(1, (person.injury || 0) / 100) * INJURY_SPEED_PENALTY;
  return base * frailMul * injMul;
}

function processFrailty(person, people, state, dayRolled) {
  if (person.alive === false) return;
  // remember the un-penalized speed once so penalties compose cleanly
  if (person._baseSpeed == null) person._baseSpeed = person.speed;

  if (dayRolled) {
    // elders accrue frailty; injuries heal (a nearby healer speeds recovery)
    if (person.lifeStage === LIFE_STAGES.ELDER) person.frailty = Math.min(100, (person.frailty || 0) + FRAILTY_PER_DAY);
    if (person.injury > 0) {
      const healerNear = people.some(p => p !== person && p.alive !== false && (p.skills?.healing || 0) > 25 && distBetween(p, person) < 5);
      person.injury = Math.max(0, person.injury - INJURY_HEAL_PER_DAY - (healerNear ? HEALER_HEAL_BONUS : 0));
    }
    // daily health accounting: regen when well, erode under stress/frailty/injury
    let dh = HEALTH_REGEN_PER_DAY;
    if (person.hunger > 80) dh -= 6;
    if (person.sick) dh -= 5;
    dh -= (person.frailty || 0) * 0.08;
    dh -= (person.injury || 0) * 0.05;
    person.health = clamp((person.health ?? 100) + dh, 0, 100);
  }

  // apply frailty/injury to live movement speed
  person.speed = effectiveSpeed(person);

  // elders occasionally voice their aches — flavor that telegraphs decline
  if ((person.frailty > 20 || person.injury > 20) && person.acheTimer <= 0 && !person.sleeping && Math.random() < 0.002) {
    person.acheTimer = 300;
    setEmote(person, 'sick', 18);
    if (person.mood === 'neutral' || person.mood === 'content') person.mood = 'thoughtful';
    person.thought = person.injury > 20 ? 'This wound still aches...' : 'My old bones aren\'t what they were.';
  }
  if (person.acheTimer > 0) person.acheTimer--;
}

// ── Death — now driven by declining health, not a pure random flip (#10) ──

function processDeath(person, state) {
  if (person.alive === false) return;
  const h = person.health ?? 100;
  // failing health is the main path out — likelier the lower it gets, and only
  // really bites for elders, the badly injured, or the starving.
  if (h < 35) {
    const risk = ((35 - h) / 35) * 0.004;
    if (Math.random() < risk) {
      const cause = person.injury > 50 ? 'their injuries'
        : person.sick ? 'a long illness'
        : person.lifeStage === LIFE_STAGES.ELDER ? 'old age'
        : person.hunger >= 90 ? 'starvation and weakness'
        : 'failing health';
      killPerson(person, state, cause);
      return;
    }
  }
  // a small floor of genuine accidents keeps mortality from being fully predictable
  if (Math.random() < 0.000004) {
    person.injury = Math.min(100, (person.injury || 0) + 40);
    person.health = clamp((person.health ?? 100) - 15, 0, 100);
    setEmote(person, 'fear', 20);
    addMemory(person, 'Had a bad accident', 'danger', state.day, { location: person.currentLocation });
  }
}

function killPerson(person, state, cause) {
  person.alive = false;
  person.sleeping = false;
  person.eating = false;
  person.conversationId = null;
  person.activity = 'dead';
  person.emote = null;
  state.stats.totalDeaths++;

  const alivePeople = state.people.filter(p => p.alive !== false && p.name !== person.name);
  for (const p of alivePeople) {
    const rel = p.relationships[person.name];
    if (rel && rel.affection > 30) {
      p.mood = 'sad';
      p.griefTimer = 80 + Math.floor(rel.affection); // grief proportional to affection
      p.griefTarget = person.name;
      setEmote(p, 'tear', 80);
      addMemory(p, `${person.name} passed away from ${cause}`, 'death', state.day);
      // grief period — seek campfire for funeral
      p.targetX = LOCATIONS.CAMPFIRE.x + (Math.random() - 0.5) * 3;
      p.targetY = LOCATIONS.CAMPFIRE.y + (Math.random() - 0.5) * 3;
      setGoal(p, 'mourn', null, 40);
    }
    if (p.partner === person.name) {
      p.partner = null;
      p.mood = 'heartbroken';
      setEmote(p, 'tear', 120);
      addMemory(p, `Lost my partner ${person.name}`, 'death', state.day);
    }
  }
  state.events.push({ day: state.day, hour: state.hour, participants: [person.name], summary: `${person.name} passed away from ${cause}.`, type: 'death' });

  // ── Oral tradition (Phase 5) ── knowledge dies with its keeper unless someone
  // still living also knows it. A breakthrough that was never taught is LOST —
  // the village forgets how, and someone may have to rediscover it later.
  for (const techId of Object.keys(person.knownTech || {})) {
    const stillKnown = alivePeople.some(p => p.knownTech?.[techId]);
    if (!stillKnown && state.knownTech[techId]) {
      delete state.knownTech[techId];
      const tech = recipeFor(state, techId);
      state.events.push({ day: state.day, hour: state.hour, participants: [person.name],
        summary: `📜 The secret of ${tech?.label || techId} died with ${person.name}.`, type: 'knowledge_lost' });
      simlog('tech.forgotten', { day: state.day, recipe: techId, label: tech?.label,
        person: person.name }, `📜 ${tech?.label || techId} forgotten — died with ${person.name}`);
      // drop the village-wide tech effect that depended on it
      recomputeTechEffects(state);
    }
  }
}

// Smite via the proper death pipeline so the World panel, stats, oral-tradition
// knowledge loss, grief and the death event all fire (raw alive=false skipped
// all of that). Called by the Smite god power.
export function divineKill(state, targetIdx, cause = 'divine wrath') {
  const target = state.people[targetIdx];
  if (!target || target.alive === false || target.isAvatar) return;
  killPerson(target, state, cause);
}

// Resurrection — bring a dead villager back. Restores life, clears the death
// state, gives them a full bar of health, and leaves everyone (and the revived)
// a heavy, lasting memory. The village's awe surges. Returns nothing; mutates.
export function resurrect(state, targetIdx) {
  const target = state.people[targetIdx];
  if (!target || target.alive !== false || target.isAvatar) return;
  target.alive = true;
  target.activity = 'idle';
  target.health = 100;
  target.hunger = 20; target.tiredness = 10; target.loneliness = 30;
  target.injury = 0; target.sick = false; target.sickTimer = 0;
  target.frailty = Math.min(target.frailty || 0, 20); // come back a little frail, not aged out
  target.sleeping = false; target.eating = false;
  target.mood = 'excited';
  setEmote(target, 'sparkle', 60);
  addMemory(target, 'I was dead — and the gods called me back.', 'achievement', state.day, { valence: 3 });
  target.thought = 'I... I was gone. And now I am here again.';
  state.stats.totalDeaths = Math.max(0, (state.stats.totalDeaths || 0) - 1);
  state.events.push({ day: state.day, hour: state.hour, participants: [target.name],
    summary: `🌟 The gods raised ${target.name} from death!`, type: 'god' });
  for (const p of state.people) {
    if (p.isAvatar || p.alive === false || p.name === target.name) continue;
    p.awe = Math.min(100, (p.awe || 0) + 40);
    addMemory(p, `Witnessed ${target.name} brought back from death — the gods are real.`, 'god', state.day, { valence: 3 });
    if (p.mood === 'sad' || p.mood === 'heartbroken') p.mood = 'excited';
    setEmote(p, 'sparkle', 40);
    // mend partner/loved bonds that the death severed
    if (target.relationships?.[p.name]) {
      const r = p.relationships[target.name] || (p.relationships[target.name] = blankRel('friend'));
      r.affection = clamp((r.affection || 50) + 10, 0, 100);
      r.trust = clamp((r.trust || 50) + 10, 0, 100);
    }
  }
}

// Recompute village-wide tech multipliers from whatever knowledge survives, so a
// lost invention actually rolls back its benefit (Phase 5 stakes).
function recomputeTechEffects(state) {
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

// ── Breakups ──

function processBreakups(person, people, state) {
  if (!person.partner) return;
  const rel = person.relationships[person.partner];
  if (!rel) return;

  // breakup if affection drops too low
  if (rel.affection < 25 && rel.trust < 25 && rel.stage !== RELATIONSHIP_STAGES.STRANGER) {
    const partnerName = person.partner;
    const partner = people.find(p => p.name === partnerName);
    if (partner) {
      const pRel = partner.relationships[person.name];
      if (pRel) { pRel.stage = RELATIONSHIP_STAGES.ACQUAINTANCE; pRel.attraction = Math.max(0, pRel.attraction - 20); }
      partner.partner = null;
      partner.mood = 'heartbroken';
      setEmote(partner, 'tear', 60);
      addMemory(partner, `Broke up with ${person.name}`, 'life', state.day, { valence: -2 });
    }
    rel.stage = RELATIONSHIP_STAGES.ACQUAINTANCE;
    rel.attraction = Math.max(0, rel.attraction - 20);
    person.partner = null;
    person.mood = 'heartbroken';
    setEmote(person, 'tear', 60);
    addMemory(person, `Broke up with ${partnerName}`, 'life', state.day, { valence: -2 });
    state.events.push({ day: state.day, hour: state.hour, participants: [person.name, partnerName].filter(Boolean), summary: `${person.name} and ${partnerName} broke up.`, type: 'breakup' });
  }

  // jealousy confrontation
  if (rel.jealousy > 60 && Math.random() < 0.01) {
    person.mood = 'annoyed';
    rel.trust = Math.max(0, rel.trust - 5);
    rel.affection = Math.max(0, rel.affection - 3);
    addMemory(person, `Had a jealous argument with ${person.partner}`, 'conflict', state.day);
    state.events.push({ day: state.day, hour: state.hour, participants: [person.name, person.partner], summary: `${person.name} confronted ${person.partner} about jealousy.`, type: 'conflict' });
    rel.jealousy = Math.max(0, rel.jealousy - 20);
  }
}

// ── Ambient events ──

function processAmbientEvents(state) {
  if (state.tick % 150 !== 0) return; // every ~2.5 game-hours

  let pool = AMBIENT_EVENTS[state.timeOfDay] || [];
  if (state.weather === 'rainy' || state.weather === 'storm') {
    pool = [...pool, ...(AMBIENT_EVENTS[state.weather] || [])];
  }
  if (!pool.length) return;

  const text = pool[Math.floor(Math.random() * pool.length)];
  state.events.push({ day: state.day, hour: state.hour, participants: [], summary: text, type: 'ambient' });

  // storm clears after a while
  if (state.weather === 'storm' && Math.random() < 0.15) {
    state.weather = 'rainy';
  }
  if (state.weather === 'rainy' && Math.random() < 0.08) {
    state.weather = 'clear';
  }
}

// ── Seasonal events ──

function processSeasonalEvents(state) {
  // every 7 days, a village gathering
  if (state.hour === 18 && state.minute === 0 && state.day % 7 === 0) {
    const eventTypes = [
      { name: 'Harvest Festival', desc: 'The village gathers to celebrate the harvest!' },
      { name: 'Storytelling Night', desc: 'Everyone gathers around the campfire for stories.' },
      { name: 'Village Feast', desc: 'A communal feast brings everyone together.' },
    ];
    const event = eventTypes[Math.floor(Math.random() * eventTypes.length)];
    const alivePeople = state.people.filter(p => p.alive !== false);
    for (const p of alivePeople) {
      p.targetX = LOCATIONS.CAMPFIRE.x + (Math.random() - 0.5) * 3;
      p.targetY = LOCATIONS.CAMPFIRE.y + (Math.random() - 0.5) * 3;
      setGoal(p, 'event', null, 30);
      p.mood = 'happy';
      p.hunger = Math.max(0, p.hunger - 20);
      p.loneliness = Math.max(0, p.loneliness - 20);
      setEmote(p, 'sparkle', 30);
      if (event.name === 'Storytelling Night') gainSkill(p, 'storytelling', 0.2);
      addMemory(p, `Joined the ${event.name} at the Campfire`, 'kindness', state.day, { location: 'Campfire' });
    }
    state.events.push({ day: state.day, hour: state.hour, participants: alivePeople.map(p => p.name), summary: `🎉 ${event.name}! ${event.desc}`, type: 'seasonal' });
  }

  // partner ceremony when new couple forms
  // (handled in relationship stage updates)
}

// ════════════════════════════════════════════════════════════════════════════
// GOD AVATAR — the deity walks among the villagers
//
// A special person the human drives directly (WASD movement, typed dialogue).
// It lives in state.people so it renders and is perceived/talked-to like anyone,
// but `isAvatar` excludes it from all autonomous simulation. It can appear as a
// mysterious stranger (villagers treat it as a normal newcomer) or as an obvious
// deity (its words carry awe and reputation weight).
// ════════════════════════════════════════════════════════════════════════════

const AVATAR_ID = 999999;

// Create and place the avatar near the campfire. `divine` chooses how villagers
// perceive it. Returns the new state (avatar appended to people).
export function spawnAvatar(state, { divine = false, name } = {}) {
  if (state.people.some(p => p.isAvatar)) return state; // only one at a time
  const cf = LOCATIONS.CAMPFIRE;
  const avatar = {
    id: AVATAR_ID,
    isAvatar: true,
    divine,
    name: name || (divine ? 'The Presence' : 'Wanderer'),
    gender: 'other',
    age: 0,
    lifeStage: LIFE_STAGES.ADULT,
    color: divine ? 0xffe066 : 0xcccccc,
    traits: [], values: [],
    x: cf.x, y: cf.y,
    targetX: null, targetY: null,
    currentLocation: 'Campfire',
    mood: divine ? 'loving' : 'neutral',
    activity: 'idle',
    alive: true,
    sleeping: false, eating: false, sick: false,
    conversationId: null, conversationCooldown: 0,
    relationships: {}, reputationBeliefs: {},
    memories: [], conversationLog: [],
    skills: {}, inventory: {}, larder: {},
    hunger: 0, tiredness: 0, loneliness: 0,
    injury: 0, frailty: 0, awe: 0,
    emote: null, emoteTimer: 0,
    partner: null, home: null, children: [], parents: [],
    // a model so the avatar could (later) speak autonomously; harmless if unused
    model: pickModelWeighted(state.modelStats),
    speechStyle: divine ? 'Speaks with calm, weighty certainty.' : 'Speaks plainly, like a traveler.',
  };
  // seed a fresh stranger relationship both ways so rapport can actually build
  // across visits (villagers start knowing nothing about this newcomer).
  for (const v of state.people) {
    if (v.isAvatar) continue;
    avatar.relationships[v.name] = blankRel('stranger');
    v.relationships[avatar.name] = blankRel('stranger');
  }
  return { ...state, people: [...state.people, avatar], avatarId: AVATAR_ID };
}

// A neutral relationship record (mirrors initRelationships' shape).
function blankRel(stage = 'stranger') {
  return { affection: 45, trust: 45, attraction: 0, familiarity: 0, stage, jealousy: 0 };
}

export function despawnAvatar(state) {
  const avatar = getAvatar(state);
  if (!avatar) return state;
  // Villagers NOTICE the stranger/presence vanish. Anyone who was near reacts:
  // a normal stranger leaving is mildly notable; a divine presence vanishing is
  // eerie and memorable. This also releases anyone still flagged in the convo.
  const convo = state.activeConversations.find(c => c.avatar);
  const knewThem = new Set(convo?.participants || []);
  for (const p of state.people) {
    if (p.isAvatar) continue;
    if (p.conversationId === convo?.id) p.conversationId = null; // release from avatar chat
    const wasNear = distBetween(p, avatar) < 7;
    if (!wasNear && !knewThem.has(p.name)) continue;
    if (avatar.divine) {
      addMemory(p, `The presence vanished as suddenly as it came. Where did it go?`, 'god', state.day,
        { location: p.currentLocation, valence: 1 });
      p.awe = Math.min(100, (p.awe || 0) + 8);
      p.mood = 'thoughtful';
      setEmote(p, 'sparkle', 20);
    } else {
      addMemory(p, `That stranger, ${avatar.name}, is gone. Didn't even say goodbye.`, 'life', state.day,
        { location: p.currentLocation, valence: 0.2 });
      setEmote(p, 'thought', 16);
    }
    p.thought = avatar.divine ? 'The presence... it left. I felt it.' : `Where did ${avatar.name} go?`;
  }
  return {
    ...state,
    people: state.people.filter(p => !p.isAvatar),
    activeConversations: state.activeConversations.filter(c => !c.avatar),
    avatarId: null,
  };
}

export function getAvatar(state) {
  return state.people.find(p => p.isAvatar) || null;
}

// Move the avatar by a tile-space delta (called from the keyboard loop). Clamps
// to the map and routes around water using the same walkable check as villagers.
export function moveAvatar(state, dx, dy) {
  const a = getAvatar(state);
  if (!a) return state;
  const nx = clamp(a.x + dx, 0, MAP_W - 1);
  const ny = clamp(a.y + dy, 0, MAP_H - 1);
  // don't walk into water (gods can, but it looks odd); allow if no better option
  if (state.terrain?.[Math.round(ny)]?.[Math.round(nx)]?.type !== TERRAIN.WATER) {
    a.x = nx; a.y = ny;
  } else {
    // allow axis-only slide so movement doesn't feel stuck against the shore
    if (state.terrain?.[Math.round(a.y)]?.[Math.round(nx)]?.type !== TERRAIN.WATER) a.x = nx;
    else if (state.terrain?.[Math.round(ny)]?.[Math.round(a.x)]?.type !== TERRAIN.WATER) a.y = ny;
  }
  a.currentLocation = locationAt(a.x, a.y);
  return state;
}

// A human-authored avatar line → nearby villagers hear it and reply via their own
// LLMs. The avatar's words land as memories and (optionally, when divine) shift
// mood/awe/reputation. Drives one round: avatar speaks, then each nearby villager
// who chooses to responds. Returns updated state via onUpdate, like runConversation.
export async function avatarSpeak(gameRef, text, onUpdate, signal) {
  const cs = gameRef.current;
  const avatar = getAvatar(cs);
  if (!avatar || !text?.trim()) return;

  // who's close enough to hear (a bit generous on the larger map so you don't
  // have to stand on top of someone)
  const HEAR_RANGE = 7;
  const listeners = cs.people.filter(p =>
    !p.isAvatar && p.alive !== false && p.lifeStage !== LIFE_STAGES.BABY &&
    distBetween(avatar, p) < HEAR_RANGE && !p.sleeping);

  // nobody in earshot — give clear feedback instead of silently doing nothing
  // (a common confusion on the big map: the avatar speaks to empty air).
  if (listeners.length === 0) {
    let convo0 = cs.activeConversations.find(c => c.avatar);
    if (!convo0) {
      const cid = cs.nextConvoId;
      gameRef.current = { ...cs, nextConvoId: cid + 1 };
      convo0 = { id: cid, participants: [avatar.name], lines: [], location: avatar.currentLocation, startTick: cs.tick, active: true, avatar: true };
      gameRef.current = { ...gameRef.current, activeConversations: [...gameRef.current.activeConversations, convo0] };
    }
    convo0.lines.push({ speaker: avatar.name, text: text.trim(), thought: null, mood: avatar.mood, addressedTo: 'everyone' });
    convo0.lines.push({ speaker: 'narrator', text: 'No one is close enough to hear. Walk nearer to a villager (WASD).', thought: null, mood: null });
    setEmote(avatar, 'sparkle', 10);
    pushAvatarConvo(gameRef, convo0);
    onUpdate?.();
    return;
  }

  // find or open a conversation anchored on the avatar
  let convo = cs.activeConversations.find(c => c.participants.includes(avatar.name));
  if (!convo) {
    const convoId = cs.nextConvoId;
    gameRef.current = { ...cs, nextConvoId: convoId + 1 };
    convo = {
      id: convoId,
      participants: [avatar.name, ...listeners.map(p => p.name)],
      lines: [], location: avatar.currentLocation, startTick: cs.tick, active: true, avatar: true,
    };
    gameRef.current = { ...gameRef.current, activeConversations: [...gameRef.current.activeConversations, convo] };
  } else {
    // refresh the listener roster as the avatar moves around
    for (const l of listeners) if (!convo.participants.includes(l.name)) convo.participants.push(l.name);
  }

  // record the avatar's spoken line
  convo.lines.push({ speaker: avatar.name, text: text.trim(), thought: null, mood: avatar.mood, addressedTo: 'everyone' });
  setEmote(avatar, 'sparkle', 12);

  // the divine word leaves a mark on everyone who heard it, and we LOCK them into
  // the avatar conversation (conversationId) so the autonomous loop can't grab
  // them mid-reply — this was the race that trampled their state.
  for (const l of listeners) {
    l.conversationId = convo.id;
    addMemory(l, `${avatar.divine ? 'A divine voice' : avatar.name} said: "${text.trim().slice(0, 80)}"`,
      avatar.divine ? 'god' : 'conversation', cs.day, { location: avatar.currentLocation, valence: avatar.divine ? 1.5 : 0.3 });
    if (avatar.divine) { l.awe = Math.min(100, (l.awe || 0) + 12); }
  }
  pushAvatarConvo(gameRef, convo);
  onUpdate?.();

  // each listener gets a chance to reply (in proximity order), via their own model.
  // Wrapped in try/finally so a thrown error mid-reply (e.g. a malformed AI result
  // being dereferenced) can never leave listeners locked with conversationId set —
  // which would silently exclude them from all future ticks forever.
  const history = convo.lines.map(li => ({ speaker: li.speaker, text: li.text }));
  try {
    for (const listener of listeners.sort((a, b) => distBetween(avatar, a) - distBetween(avatar, b)).slice(0, 3)) {
      if (signal?.aborted) break;
      // the player may have despawned the avatar mid-loop — stop cleanly if so
      if (!getAvatar(gameRef.current)) break;
      const others = [avatar, ...listeners.filter(p => p !== listener)];
      // generateGroupDialogue appends the reply to `history` itself, so we pass it
      // through and DON'T push again (that caused duplicate lines in the prompt).
      const result = await generateAvatarReply(listener, avatar, others, cs, history, signal);
      if (!result || !result.dialogue?.trim()) continue;
      convo.lines.push({ speaker: listener.name, text: result.dialogue.trim(), thought: result.internal_thought, mood: result.mood_after, addressedTo: avatar.name });
      listener.mood = result.mood_after || listener.mood;
      listener.thought = result.internal_thought || listener.thought;
      // talking with the avatar actually builds a relationship now (rapport across
      // visits). Apply the LLM's deltas to the listener→avatar relationship.
      applyAvatarRelationship(listener, avatar, result);
      pushAvatarConvo(gameRef, convo);
      onUpdate?.();
    }
  } finally {
    // release listeners back to normal life once the exchange settles, with a short
    // cooldown so they don't immediately get yanked into an autonomous chat.
    for (const l of listeners) {
      if (l.conversationId === convo.id) { l.conversationId = null; l.conversationCooldown = 8 + Math.floor(Math.random() * 6); }
    }
  }
}

// Apply the LLM's relationship deltas from an avatar reply to the listener's
// view of the avatar (the entry is seeded in spawnAvatar, so it always exists).
function applyAvatarRelationship(listener, avatar, result) {
  const rel = listener.relationships[avatar.name];
  if (!rel) return;
  const changes = result.relationship_changes?.[avatar.name] || {};
  rel.affection = clamp(rel.affection + (changes.affection || 0), 0, 100);
  rel.trust = clamp(rel.trust + (changes.trust || 0), 0, 100);
  rel.attraction = clamp(rel.attraction + (changes.attraction || 0), 0, 100);
  rel.familiarity = clamp(rel.familiarity + 3, 0, 100); // meeting them builds familiarity
  if (rel.familiarity > 20 && rel.stage === 'stranger') rel.stage = 'acquaintance';
}

// PROVE IT — a visible miracle performed BY the avatar, for the villagers who
// demand proof that this stranger is what they claim. Unlike the global god
// powers, this is localized and ATTRIBUTED to the avatar by name, so witnesses
// connect the wonder to the figure standing in front of them and start to
// believe. Heals, feeds, and floods nearby villagers with awe + a heavy memory.
// Returns the count of witnesses (so the UI can react).
export function performAvatarMiracle(gameRef) {
  const cs = gameRef.current;
  const avatar = getAvatar(cs);
  if (!avatar) return 0;
  const RANGE = 8;
  const witnesses = cs.people.filter(p =>
    !p.isAvatar && p.alive !== false && distBetween(avatar, p) < RANGE);

  // a light-burst particle cue on the avatar itself
  setEmote(avatar, 'sparkle', 60);

  let convo = cs.activeConversations.find(c => c.avatar);
  if (!convo) {
    const cid = cs.nextConvoId;
    gameRef.current = { ...cs, nextConvoId: cid + 1 };
    convo = { id: cid, participants: [avatar.name], lines: [], location: avatar.currentLocation, startTick: cs.tick, active: true, avatar: true };
    gameRef.current = { ...gameRef.current, activeConversations: [...gameRef.current.activeConversations, convo] };
  }
  convo.lines.push({ speaker: 'narrator', text: `${avatar.name} raises a hand — light pours out. Wounds close, hunger fades, the air hums.`, thought: null, mood: null });

  for (const p of witnesses) {
    // the wonder itself: full relief + healing, the kind no mortal could do
    p.hunger = 0;
    p.tiredness = Math.max(0, p.tiredness - 40);
    p.health = 100;
    p.injury = 0;
    p.sick = false; p.sickTimer = 0;
    p.awe = Math.min(100, (p.awe || 0) + 55);
    p.mood = 'excited';
    setEmote(p, 'sparkle', 50);
    // a heavy, lasting memory tied to THIS figure — the seed of belief
    addMemory(p, `Saw ${avatar.name} work a miracle before my eyes — light, healing, no trick. They are no ordinary stranger.`,
      'god', cs.day, { location: avatar.currentLocation, valence: 3 });
    // their trust in the avatar leaps (belief)
    const rel = p.relationships[avatar.name] || (p.relationships[avatar.name] = blankRel('acquaintance'));
    rel.trust = clamp(rel.trust + 30, 0, 100);
    rel.affection = clamp(rel.affection + 15, 0, 100);
    rel.familiarity = clamp(rel.familiarity + 10, 0, 100);
    p.thought = `It's real. ${avatar.name} is real.`;
  }
  cs.events.push({ day: cs.day, hour: cs.hour, participants: [avatar.name, ...witnesses.map(w => w.name)],
    summary: `🌟 ${avatar.name} performed a miracle before ${witnesses.length} witness${witnesses.length === 1 ? '' : 'es'}!`, type: 'god' });
  const list = gameRef.current.activeConversations.map(c => c.id === convo.id ? { ...convo, lines: [...convo.lines] } : c);
  gameRef.current = { ...gameRef.current, activeConversations: list };
  return witnesses.length;
}

// End the avatar conversation, releasing listeners (called on despawn or "leave").
export function endAvatarConversation(state) {
  const convo = state.activeConversations.find(c => c.avatar);
  if (!convo) return state;
  convo.active = false;
  return { ...state, activeConversations: state.activeConversations.filter(c => !c.avatar) };
}

function pushAvatarConvo(gameRef, convo) {
  const list = gameRef.current.activeConversations.map(c =>
    c.id === convo.id ? { ...convo, lines: [...convo.lines], participants: [...convo.participants] } : c);
  gameRef.current = { ...gameRef.current, activeConversations: list };
}

// ── Conversations ──

export function findConversationGroup(people) {
  const available = people.filter(p =>
    p.alive !== false && !p.isAvatar && !p.conversationId && p.conversationCooldown <= 0 &&
    !p.sleeping && !p.eating && p.lifeStage !== LIFE_STAGES.BABY &&
    // a starving or exhausted person has no business chatting — survival first
    p.hunger <= GATE.STARVING && p.tiredness <= GATE.EXHAUSTED
  );
  if (available.length < 2) return null;
  for (const anchor of available) {
    const nearby = available.filter(p => p.name !== anchor.name && distBetween(anchor, p) < 4);
    if (nearby.length === 0) continue;
    const group = [anchor, ...nearby].slice(0, 4);
    return group.map(p => people.indexOf(p));
  }
  return null;
}

// Reject dialogue that won't read right: too short, or not predominantly latin
// script (some pool models occasionally drift into Chinese/other scripts). We
// don't need perfect language detection — just "is this mostly English letters".
function isUsableDialogue(text) {
  if (!text || text.length < 2) return false;
  const letters = (text.match(/[a-zA-Z]/g) || []).length;
  // any CJK / Hangul (unified ideographs, CJK symbols, Hangul) → reject outright
  const cjk = (text.match(/[\u3000-\u303f\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/g) || []).length;
  if (cjk > 0) return false;
  const alnum = (text.match(/[a-zA-Z0-9]/g) || []).length;
  return letters >= 3 && alnum / text.length > 0.4; // mostly real words
}

export async function runConversation(gameRef, participantIndices, onUpdate, signal) {
  const people = gameRef.current.people;
  const participants = participantIndices.map(i => people[i]);
  const convoId = gameRef.current.nextConvoId;
  gameRef.current = { ...gameRef.current, nextConvoId: convoId + 1 };

  for (const p of participants) {
    p.conversationId = convoId; p.activity = 'socializing';
    p.targetX = null; p.targetY = null;
    p.loneliness = clamp(p.loneliness - 10, 0, 100);
  }

  const conversation = {
    id: convoId, participants: participants.map(p => p.name),
    lines: [], location: participants[0].currentLocation,
    startTick: gameRef.current.tick, active: true,
  };
  const history = [];

  gameRef.current = { ...gameRef.current, activeConversations: [...gameRef.current.activeConversations, conversation] };
  onUpdate();

  // Everything below locks participants into the conversation. Wrap it so that if
  // anything throws (a malformed AI reply being dereferenced, etc.) we ALWAYS
  // release them — otherwise they'd keep conversationId set forever and silently
  // drop out of all future ticks (the only permanent-lock bug from AI failure).
  try {

  // target lines = 2-4 per person. We count PRODUCED lines, not attempts, so a
  // flaky model failing a turn doesn't silently burn the whole conversation.
  const targetLines = participants.length * (2 + Math.floor(Math.random() * 3));
  let lastSpeakerIdx = -1;
  const speakCount = new Map(participants.map(p => [p.name, 0]));
  // a per-speaker failure tally — someone whose model keeps failing gets skipped
  const failCount = new Map(participants.map(p => [p.name, 0]));
  let produced = 0;
  let attempts = 0;
  const maxAttempts = targetLines * 3; // generous headroom for retries

  while (produced < targetLines && attempts < maxAttempts) {
    attempts++;
    // Someone who broke off via a survival reflex sets _leftConversation. Narrate
    // their exit once; only END the conversation if fewer than 2 people remain.
    const quitter = participants.find(p => p._leftConversation === convoId);
    if (quitter) {
      conversation.lines.push({ speaker: 'narrator', text: `${quitter.name} breaks off — ${quitter.hunger > GATE.STARVING ? 'too hungry to keep talking' : 'needs to rest'}.`, thought: null, mood: null });
      quitter._leftConversation = null;
    }
    // present = still in the convo AND not hopelessly failing (3+ misses)
    const present = participants.filter(p => p.conversationId === convoId && p.alive !== false && failCount.get(p.name) < 3);
    if (present.length < 2) break;
    // Early bail: if nothing has landed yet and everyone present is already
    // failing, the AI layer is down (e.g. all models 404ing). Don't grind through
    // maxAttempts × 500ms sleeps locking these villagers in a silent stall —
    // give up now and let the cleanup release them.
    if (produced === 0 && present.every(p => failCount.get(p.name) >= 2)) break;

    let speakerIdx = pickNextSpeaker(participants, lastSpeakerIdx, speakCount, conversation.lines);
    let speaker = participants[speakerIdx];
    // pick someone present and reliable if the chosen speaker isn't usable
    if (!present.includes(speaker)) {
      speaker = present.find(p => p !== participants[lastSpeakerIdx]) || present[0];
      speakerIdx = participants.indexOf(speaker);
    }
    const others = participants.filter(p => p.name !== speaker.name);
    const cs = gameRef.current;
    const context = `${participants.length} people at ${conversation.location}. ${cs.timeOfDay}, day ${cs.day}. ${cs.weather}. ${
      conversation.lines.length === 0 ? 'They just gathered.' : ''
    }${speaker.partner ? ` ${speaker.name} is with ${speaker.partner}.` : ''}${
      speaker.hunger > 60 ? ` ${speaker.name} is hungry.` : ''}${speaker.tiredness > 60 ? ` Tired.` : ''}`;

    if (signal?.aborted) break;
    const result = await generateGroupDialogue(speaker, others, cs.people, context, history, signal);
    let dialogue = typeof result?.dialogue === 'string' ? result.dialogue.trim() : '';
    // reject garbage: empty, or not predominantly latin/English (some pool models
    // drift into other scripts). Count it as a failure for this speaker.
    if (!result || !dialogue || !isUsableDialogue(dialogue)) {
      recordModelResult(gameRef.current, speaker.model, false); // model produced garbage (#8)
      failCount.set(speaker.name, failCount.get(speaker.name) + 1);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    recordModelResult(gameRef.current, speaker.model, true);

    // cheap models love to parrot — drop a line that nearly duplicates one this
    // conversation already had. Retry (doesn't count toward produced lines).
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);
    const nd = norm(dialogue);
    if (conversation.lines.some(l => l.text && norm(l.text) === nd)) {
      if (history.length) history.pop(); // don't let the dupe poison future prompts
      failCount.set(speaker.name, failCount.get(speaker.name) + 1);
      await new Promise(r => setTimeout(r, 400));
      continue;
    }
    produced++;
    failCount.set(speaker.name, 0); // success resets their tally

    conversation.lines.push({
      speaker: speaker.name, text: dialogue, thought: result.internal_thought,
      mood: result.mood_after, addressedTo: result.addressed_to || 'everyone',
    });
    speaker.mood = result.mood_after || speaker.mood;
    speaker.thought = result.internal_thought;
    speakCount.set(speaker.name, (speakCount.get(speaker.name) || 0) + 1);
    lastSpeakerIdx = speakerIdx;

    // relationship changes — boosted familiarity
    if (result.relationship_changes) {
      for (const [name, changes] of Object.entries(result.relationship_changes)) {
        const rel = speaker.relationships[name];
        if (!rel) continue;
        // durable emotional history applies a tiny slow pressure on top of the
        // LLM's per-line deltas, without overriding them.
        const nudge = clamp(personValence(speaker, name) * 0.2, -1, 1);
        rel.affection = clamp(rel.affection + (changes.affection || 0) + nudge, 0, 100);
        rel.trust = clamp(rel.trust + (changes.trust || 0) + nudge, 0, 100);
        rel.attraction = clamp(rel.attraction + (changes.attraction || 0), 0, 100);
        rel.familiarity = clamp(rel.familiarity + 2, 0, 100); // +2 per line, not +1
      }
    }

    if (result.mood_after === 'flirty') setEmote(speaker, 'heart', 15);
    else if (result.mood_after === 'annoyed') setEmote(speaker, 'anger', 15);
    else if (result.mood_after === 'sad') setEmote(speaker, 'tear', 15);
    else if (result.mood_after === 'excited') setEmote(speaker, 'sparkle', 15);

    let convos = gameRef.current.activeConversations.map(c =>
      c.id === convoId ? { ...conversation, lines: [...conversation.lines] } : c
    );
    gameRef.current = { ...gameRef.current, activeConversations: convos };
    onUpdate();

    // ── GOSSIP BEAT (#2) ── occasionally the speaker turns to an absent third
    // party. Listeners present shift their private belief toward the speaker's
    // lean, so reputation spreads (and distorts) without direct interaction.
    if (!signal?.aborted && produced >= 2 && Math.random() < GOSSIP_CHANCE) {
      const absent = pickGossipTarget(speaker, others, cs.people);
      if (absent) {
        const g = await generateGossip(speaker, others[0], absent.name, cs, signal);
        if (g && isUsableDialogue(g.dialogue)) {
          conversation.lines.push({ speaker: speaker.name, text: g.dialogue, thought: `(about ${absent.name})`, mood: speaker.mood, addressedTo: others[0].name });
          const sign = g.lean === 'positive' ? 1 : g.lean === 'negative' ? -1 : 0;
          applyGossip(speaker, others, absent.name, sign, cs);
          convos = gameRef.current.activeConversations.map(c => c.id === convoId ? { ...conversation, lines: [...conversation.lines] } : c);
          gameRef.current = { ...gameRef.current, activeConversations: convos };
          onUpdate();
        }
      }
    }

    // ── TEACHING BEAT (#7) ── if the speaker is a flagged expert and a present
    // novice needs the lesson, run a short teaching exchange and bump their skill.
    if (!signal?.aborted && speaker._pendingTeach) {
      const student = others.find(o => o.name === speaker._pendingTeach.student);
      const skill = speaker._pendingTeach.skill;
      speaker._pendingTeach = null;
      if (student && skill) {
        const t = await generateTeaching(speaker, student, skill, signal);
        if (t && isUsableDialogue(t.dialogue)) {
          conversation.lines.push({ speaker: speaker.name, text: t.dialogue, thought: `(teaching ${student.name} about ${skill})`, mood: speaker.mood, addressedTo: student.name });
          student.skills[skill] = Math.min(100, (student.skills[skill] || 0) + 1.5);
          addMemory(student, `${speaker.name} taught me about ${skill}`, 'kindness', cs.day, { location: conversation.location });
          addMemory(speaker, `Taught ${student.name} about ${skill}`, 'achievement', cs.day, { location: conversation.location });
          bumpReputation(cs, speaker.name, 'kind', 2);
          bumpReputation(cs, speaker.name, 'skilled', 1);
          const sr = student.relationships[speaker.name];
          if (sr) { sr.affection = clamp(sr.affection + 3, 0, 100); sr.trust = clamp(sr.trust + 3, 0, 100); }
          convos = gameRef.current.activeConversations.map(c => c.id === convoId ? { ...conversation, lines: [...conversation.lines] } : c);
          gameRef.current = { ...gameRef.current, activeConversations: convos };
          onUpdate();
        }
      }
    }

    // ── RECIPE-TEACHING BEAT (Phase 5) ── an expert passes on a whole invention
    // (the knowledge, not just skill). The student LEARNS the recipe — granting
    // knownTech directly — and is moved to try it. This is how oral tradition
    // keeps a breakthrough alive across generations.
    if (!signal?.aborted && speaker._pendingTechTeach) {
      const student = others.find(o => o.name === speaker._pendingTechTeach.student);
      const techId = speaker._pendingTechTeach.techId;
      const tech = recipeFor(gameRef.current, techId);
      speaker._pendingTechTeach = null;
      if (student && tech && !student.knownTech?.[techId]) {
        const t = await generateTeaching(speaker, student, tech.label, signal);
        if (t && isUsableDialogue(t.dialogue)) {
          conversation.lines.push({ speaker: speaker.name, text: t.dialogue, thought: `(teaching ${student.name} how to make ${tech.label})`, mood: speaker.mood, addressedTo: student.name });
          student.knownTech = { ...(student.knownTech || {}), [techId]: true };
          if (tech.role && !student.techRole) student.techRole = tech.role;
          addMemory(student, `${speaker.name} taught me how to make ${tech.label}.`, 'kindness', cs.day, { location: conversation.location, valence: 2 });
          addMemory(speaker, `Passed on how to make ${tech.label} to ${student.name}.`, 'achievement', cs.day, { location: conversation.location, valence: 1.5 });
          bumpReputation(cs, speaker.name, 'kind', 2);
          bumpReputation(cs, speaker.name, 'skilled', 2);
          setEmote(student, 'sparkle', 16);
          const sr = student.relationships[speaker.name];
          if (sr) { sr.affection = clamp(sr.affection + 4, 0, 100); sr.trust = clamp(sr.trust + 4, 0, 100); }
          convos = gameRef.current.activeConversations.map(c => c.id === convoId ? { ...conversation, lines: [...conversation.lines] } : c);
          gameRef.current = { ...gameRef.current, activeConversations: convos };
          onUpdate();
        }
      }
    }

    // let people leave once there's been a real exchange (not after line 1)
    if (!result.wants_to_continue && produced >= participants.length * 2) {
      if (participants.length > 2) {
        speaker.conversationId = null;
        speaker.conversationCooldown = 10 + Math.floor(Math.random() * 10);
        speaker.activity = 'wandering';
        pickTarget(speaker, gameRef.current.people, gameRef.current);
        conversation.lines.push({ speaker: 'narrator', text: `${speaker.name} walks away.`, thought: null, mood: null });
        participants.splice(speakerIdx, 1);
        speakCount.delete(speaker.name);
        failCount.delete(speaker.name);
        conversation.participants = participants.map(p => p.name);
        if (participants.length < 2) break;
        const convos2 = gameRef.current.activeConversations.map(c =>
          c.id === convoId ? { ...conversation, lines: [...conversation.lines] } : c
        );
        gameRef.current = { ...gameRef.current, activeConversations: convos2 };
        onUpdate(); lastSpeakerIdx = -1;
      } else break;
    }

    // faster conversation pace
    await new Promise(r => setTimeout(r, 1500 / (gameRef.current.speed || 1)));
  }

  conversation.active = false;

  // store full conversation transcript into each participant's conversationLog
  const transcript = conversation.lines
    .filter(l => l.speaker !== 'narrator')
    .map(l => ({ speaker: l.speaker, text: l.text, thought: l.thought, mood: l.mood }));

  const fullRecord = {
    id: convoId,
    participants: conversation.participants.slice(),
    lines: transcript.slice(),
    day: gameRef.current.day,
    hour: gameRef.current.hour,
    minute: gameRef.current.minute,
    location: conversation.location,
    season: gameRef.current.season,
    weather: gameRef.current.weather,
    timestamp: Date.now(),
  };

  for (const p of participants) {
    p.conversationId = null;
    p.conversationCooldown = 12 + Math.floor(Math.random() * 10);
    p.activity = 'wandering';
    p.currentGoal = null;
    // storytelling grows only a LITTLE per conversation — far less than the
    // productive skills, so real work (hunting/building/foraging) defines who
    // someone becomes, not idle chatter.
    gainSkill(p, 'storytelling', 0.08);
    rewardAction(p, 'socialize', Math.max(0.5, p.loneliness / 40), gameRef.current);
    pickTarget(p, gameRef.current.people, gameRef.current);

    // store actual conversation in their personal log (capped at 20 conversations)
    if (!p.conversationLog) p.conversationLog = [];
    p.conversationLog.push({
      participants: fullRecord.participants,
      lines: transcript.slice(),
      day: fullRecord.day,
      location: fullRecord.location,
    });
    if (p.conversationLog.length > 20) p.conversationLog.shift();

    // also add a short memory summary
    const otherNames = conversation.participants.filter(n => n !== p.name).join(', ');
    const lastThing = transcript.slice(-1)[0];
    addMemory(p, `Talked with ${otherNames} at ${conversation.location}. Last thing said: "${lastThing?.text?.slice(0, 80) || '...'}"`, 'conversation', gameRef.current.day, { location: conversation.location });
  }

  // persist to global conversation archive for analysis
  saveConversationToArchive(fullRecord);

  gameRef.current.stats.totalConversations++;
  gameRef.current = {
    ...gameRef.current,
    activeConversations: gameRef.current.activeConversations.filter(c => c.id !== convoId),
    conversations: [...gameRef.current.conversations.slice(-50), conversation], // cap at 50 past convos
    events: [...gameRef.current.events.slice(-100), { day: gameRef.current.day, hour: gameRef.current.hour, participants: conversation.participants, summary: `${conversation.participants.join(', ')} chatted at ${conversation.location}`, lineCount: conversation.lines.length }],
  };
  onUpdate();
  } finally {
    // Safety net: release anyone still locked to this conversation and drop the
    // (possibly empty) active entry. On the normal path these are already done,
    // so this only fires if the body threw — preventing a permanent lock.
    let needsRelease = false;
    for (const p of participants) {
      if (p.conversationId === convoId) {
        p.conversationId = null;
        p.conversationCooldown = 12 + Math.floor(Math.random() * 10);
        p.activity = 'wandering';
        needsRelease = true;
      }
    }
    if (needsRelease) {
      gameRef.current = {
        ...gameRef.current,
        activeConversations: gameRef.current.activeConversations.filter(c => c.id !== convoId),
      };
      onUpdate();
    }
  }
}

function pickNextSpeaker(participants, lastSpeakerIdx, speakCount, lines) {
  const minCount = Math.min(...participants.map(p => speakCount.get(p.name) || 0));
  let candidates = participants.map((p, i) => ({ p, i, count: speakCount.get(p.name) || 0 }))
    .filter(c => c.i !== lastSpeakerIdx);
  const under = candidates.filter(c => c.count <= minCount);
  if (under.length > 0) candidates = under;
  if (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last.addressedTo && last.addressedTo !== 'everyone' && last.speaker !== 'narrator') {
      const addr = candidates.find(c => c.p.name.toLowerCase() === last.addressedTo.toLowerCase());
      if (addr) return addr.i;
    }
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return pick ? pick.i : (lastSpeakerIdx + 1) % participants.length;
}

export async function runAIAction(gameRef, personIdx, signal) {
  const person = gameRef.current.people[personIdx];
  // this person's LLM turn is being consumed — clear the flag and start the
  // escalation cooldown so one event doesn't spam calls.
  person.pendingLLM = false;
  person.gateCooldown = GATE.ESCALATE_COOLDOWN;
  if (person.conversationId || person.sleeping || person.eating) return;
  if (person.lifeStage === LIFE_STAGES.BABY) return;
  // only skip if cooldown AND already has a goal
  if (person.actionCooldown > 0 && person.currentGoal?.until > 0) return;

  const cs = gameRef.current;
  // who the village turns to for each role — surfaced so the LLM can choose to
  // seek the right specialist (the best healer, hunter, builder) (#5)
  const specialists = {
    healer: bestSpecialist(cs.people, 'healing', person)?.name || null,
    hunter: bestSpecialist(cs.people, 'hunting', person)?.name || null,
    builder: bestSpecialist(cs.people, 'building', person)?.name || null,
    forager: bestSpecialist(cs.people, 'foraging', person)?.name || null,
  };
  const result = await generateAction(person, cs.people, {
    timeOfDay: cs.timeOfDay, weather: cs.weather, day: cs.day,
    hour: cs.hour, minute: cs.minute,
    season: cs.season, villageFood: totalFood(cs), larder: cs.larder,
    wildlife: cs.wildlife, buildings: cs.buildings, field: cs.field,
    learned: qBestActions(person, cs, 3),       // System 5: what's been paying off
    specialty: topSkill(person),                 // specialization identity
    reputation: cs.reputation,                   // collective standing of everyone (#2)
    myReputation: reputationLabel(cs, person.name), // how the village sees you
    specialists,                                 // village go-to people by role (#5)
  }, signal);
  recordModelResult(cs, person.model, !!result); // track model reliability (#8)
  if (!result) return;

  person.mood = result.mood || person.mood;
  person.thought = result.thought || result.reason || '';
  person.actionCooldown = 10 + Math.floor(Math.random() * 5);

  // handle dynamic goal updates from AI
  if (result.update_goals && Array.isArray(result.update_goals)) {
    for (const ug of result.update_goals) {
      if (ug.action === 'add' && ug.goal) {
        if (!person.ambitions) person.ambitions = [];
        if (!person.ambitions.find(a => a.label === ug.goal)) {
          person.ambitions.push({ id: `ai_${Date.now()}`, label: ug.goal, completed: false, check: () => false });
          addMemory(person, `Set a new goal: ${ug.goal}`, 'ambition', cs.day);
        }
      } else if (ug.action === 'drop' && ug.goal) {
        if (person.ambitions) {
          const idx = person.ambitions.findIndex(a => a.label.toLowerCase().includes(ug.goal.toLowerCase()));
          if (idx >= 0) {
            addMemory(person, `Gave up on: ${person.ambitions[idx].label}`, 'ambition', cs.day);
            person.ambitions.splice(idx, 1);
          }
        }
      }
    }
  }

  const action = result.action || '';
  const target = result.target || '';

  switch (action) {
    case 'go_to':
    case 'go_to_location':
      goToLocation(person, target);
      person.activity = 'walking';
      setGoal(person, 'go_to', target, 60);
      break;

    case 'seek_person': {
      const t = cs.people.find(o => o.name.toLowerCase().includes(target.toLowerCase()) && o.alive !== false);
      if (t) { goToPerson(person, t); person.activity = 'seeking'; setGoal(person, 'seek', t.name, 50); }
      break;
    }

    case 'rest':
      beginSleep(person, 400);
      break;

    case 'gather_food':
    case 'fish':
      goToLocation(person, action === 'fish' ? 'Fishing Spot' : 'Berry Bush');
      person.activity = 'working';
      setGoal(person, 'work', null, 100);
      break;

    case 'chop_wood':
      goToLocation(person, 'Grove');
      person.activity = 'chopping';
      setGoal(person, 'chop_wood', 'Grove', 100);
      break;

    case 'collect_stone':
      goToLocation(person, 'Rock Seat');
      person.activity = 'collecting';
      setGoal(person, 'collect_stone', 'Rock Seat', 100);
      break;

    case 'gather_thatch':
      goToLocation(person, 'Meadow');
      person.activity = 'gathering';
      setGoal(person, 'gather_thatch', 'Meadow', 100);
      break;

    case 'farm':
    case 'tend_field':
    case 'harvest':
    case 'plant_crops':
      goToLocation(person, 'Field');
      person.activity = 'farming';
      setGoal(person, 'farm', 'Field', 100);
      break;

    case 'build':
      if (!person.buildProject) {
        // anyone can decide to build — not just partnered
        startBuildProject(person, cs);
      } else if (person.buildProject.phase !== 'complete') {
        person.targetX = person.buildProject.site.x;
        person.targetY = person.buildProject.site.y;
        person.activity = 'building';
        setGoal(person, 'build', null, 80);
      }
      break;

    case 'hunt': {
      // Begin the hunt — processHunting drives the per-tick chase from here,
      // re-acquiring prey via vision and pursuing its live position. We just
      // point them at the nearest visible (or named) animal to get started.
      const tooHard = (person.skills?.hunting || 0) < 8;
      let prey = nearestVisiblePrey(person, cs, { allowDangerous: !tooHard });
      if (target) {
        const named = cs.wildlife.find(w => w.alive && w.type.toLowerCase().includes(target.toLowerCase()));
        if (named) prey = named;
      }
      if (prey) {
        person.activity = 'hunting';
        person._huntTargetId = prey.id; person._huntScan = 0;
        person.targetX = prey.x; person.targetY = prey.y;
        person.thought = `On the hunt for a ${prey.type}.`;
      } else {
        // nothing in sight — go to open ground and scan (processHunting will too)
        person.thought = 'No game in sight — heading out to look.';
        goToLocation(person, 'Grove');
        person.activity = 'hunting';
        person._huntTargetId = null; person._huntScan = 0;
      }
      break;
    }

    case 'heal_person': {
      const t = cs.people.find(o => o.name.toLowerCase().includes(target.toLowerCase()) && o.sick);
      if (t) {
        goToPerson(person, t);
        person.activity = 'healing';
        setGoal(person, 'heal', t.name, 60);
      }
      break;
    }

    case 'craft': {
      // craft a tool that boosts gathering. Costs wood — gather first if short.
      if ((person.inventory.wood || 0) < 2) {
        goToLocation(person, 'Grove');
        person.activity = 'chopping';
        setGoal(person, 'work', 'Grove', 60);
        person.thought = 'Need more wood before I can make a tool.';
        break;
      }
      person.inventory.wood -= 2;
      person.craftTool = chooseToolToCraft(person);
      person.craftProgress = 0;
      person._craftDay = cs.day;
      person.activity = 'crafting';
      // craft near a workshop if one exists, else the Campfire
      const workshop = (cs.buildings || []).find(b => /workshop/i.test(b.type || ''));
      goToLocation(person, workshop ? 'Campfire' : 'Campfire');
      setGoal(person, 'craft', null, 80);
      person.thought = `Making a ${person.craftTool.replace('_', ' ')}.`;
      break;
    }

    case 'offer_shelter': {
      // a homeowner invites a specific homeless villager to shelter in their home.
      if (!person.home || !target) break;
      const guest = cs.people.find(o =>
        o.alive !== false && !o.isAvatar && o.name !== person.name &&
        o.name.toLowerCase().includes(target.toLowerCase()) && !o.home);
      if (!guest) break;
      // share the home: the guest gains it as their shelter and joins the owners
      guest.home = person.home;
      if (!person.home.owners) person.home.owners = [person.name];
      if (!person.home.owners.includes(guest.name)) person.home.owners.push(guest.name);
      // walk the guest toward the home; the host gestures warmly
      guest.targetX = person.home.x; guest.targetY = person.home.y;
      guest.currentGoal = { type: 'shelter', target: person.name, until: 80 };
      guest.activity = 'heading home';
      guest.thought = `${person.name} offered me shelter — heading to their home.`;
      setEmote(guest, 'sparkle', 24);
      setEmote(person, 'heart', 24);
      person.activity = 'welcoming';
      setGoal(person, 'social', guest.name, 30);
      // it's a kindness: memories + reputation + a relationship bump
      addMemory(person, `Offered ${guest.name} shelter in my home.`, 'kindness', cs.day, { location: person.currentLocation, valence: 1.5 });
      addMemory(guest, `${person.name} took me into their home — I won't forget it.`, 'kindness', cs.day, { location: person.currentLocation, valence: 2.5 });
      bumpReputation(cs, person.name, 'kind', 4);
      bumpReputation(cs, person.name, 'generous', 3);
      const gr = guest.relationships[person.name];
      if (gr) { gr.affection = clamp(gr.affection + 8, 0, 100); gr.trust = clamp(gr.trust + 8, 0, 100); }
      cs.events.push({ day: cs.day, hour: cs.hour, participants: [person.name, guest.name],
        summary: `🏠 ${person.name} took ${guest.name} in from the cold.`, type: 'kindness' });
      break;
    }

    case 'sit_and_think':
    case 'explore':
      if (target) goToLocation(person, target);
      else {
        // pick a random quiet spot
        const spots = ['Pond', 'Rock Seat', 'Meadow'];
        goToLocation(person, spots[Math.floor(Math.random() * spots.length)]);
      }
      person.activity = action === 'sit_and_think' ? 'thinking' : 'exploring';
      setGoal(person, action, null, 60);
      break;

    default:
      // fallback — just wander
      pickExploreTarget(person);
      person.activity = 'wandering';
      setGoal(person, 'wander', null, 40);
  }
}

// initiate a build project by asking AI what to build
// A sensible default plan used when the LLM is unavailable or fails, so a
// villager's decision to build is never silently dropped. Homeless villagers
// default to a shelter; others to a useful communal structure.
function defaultBuildPlan(person) {
  if (!person.home) {
    return { type: 'shelter', description: 'a simple home to shelter from the cold',
      estimated_quality: 'basic', materials_needed: { wood: 5, stone: 2, thatch: 2 } };
  }
  return { type: 'storage hut', description: 'a hut to store food and goods',
    estimated_quality: 'basic', materials_needed: { wood: 4, stone: 1, thatch: 1 } };
}

// Is a tile clear enough to put a home on? Walkable, dry, and not sitting on (or
// right next to) a resource node or an existing building — so houses don't land
// on the rocks/clay/etc. that villagers harvest, and don't stack on each other.
function isBuildableTile(state, grid, x, y) {
  if (!nearestWalkableHere(grid, x, y)) return false;
  const RES_CLEAR = 1.5; // keep homes off resource tiles (and their immediate edge)
  for (const n of state.resourceNodes || []) {
    if (Math.abs(n.x - x) <= RES_CLEAR && Math.abs(n.y - y) <= RES_CLEAR) return false;
  }
  const BLD_CLEAR = 2; // don't crowd existing buildings
  for (const b of state.buildings || []) {
    if (Math.abs(b.x - x) <= BLD_CLEAR && Math.abs(b.y - y) <= BLD_CLEAR) return false;
  }
  return true;
}

// True if exactly this tile (rounded) is walkable — used as a strict per-tile test
// (unlike nearestWalkable, which would spiral to a different tile).
function nearestWalkableHere(grid, x, y) {
  const r = nearestWalkable(grid, x, y);
  return r && r.x === Math.round(x) && r.y === Math.round(y);
}

// Pick a home site near the preferred spot that's walkable AND clear of resource
// nodes / other buildings. Spirals outward from the preference so the villager's
// chosen area is honored, only moving away as far as needed to find clear ground.
function pickBuildSite(state, px, py, maxRadius = 8) {
  const grid = getWalkableGrid(state);
  const cx = Math.round(px), cy = Math.round(py);
  if (isBuildableTile(state, grid, cx, cy)) return { x: cx, y: cy };
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring only
        const nx = clamp(cx + dx, 3, MAP_W - 4), ny = clamp(cy + dy, 3, MAP_H - 4);
        if (isBuildableTile(state, grid, nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  // last resort: any walkable tile near the preference (old behavior), then campfire
  const dry = nearestWalkable(grid, cx, cy);
  return dry ? { x: dry.x, y: dry.y } : { x: LOCATIONS.CAMPFIRE.x, y: LOCATIONS.CAMPFIRE.y };
}

// Attach a buildProject from a plan object (LLM-produced or a fallback). Pure
// and synchronous — no LLM calls — so it's reusable by the god power and the
// deterministic fallback path. Returns the created project.
function createBuildProject(person, partner, state, plan) {
  const hx = LOCATIONS.CAMPFIRE.x + (Math.random() - 0.5) * 14;
  const hy = LOCATIONS.CAMPFIRE.y + (Math.random() - 0.5) * 10;
  const site = pickBuildSite(state, clamp(hx, 3, MAP_W - 4), clamp(hy, 3, MAP_H - 4));

  person.buildProject = {
    type: plan.type || 'shelter',
    description: plan.description || '',
    quality: plan.estimated_quality || 'basic',
    materialsNeeded: {
      wood: Math.max(2, Math.min(20, plan.materials_needed?.wood || 5)),
      stone: Math.max(0, Math.min(15, plan.materials_needed?.stone || 2)),
      thatch: Math.max(0, Math.min(10, plan.materials_needed?.thatch || 2)),
    },
    site,
    phase: 'planning',
    progress: 0,
  };

  // share project with partner
  if (partner) partner.buildProject = person.buildProject;

  addMemory(person, `Planning to build a ${person.buildProject.type}`, 'life', state.day);
  state.events.push({ day: state.day, hour: state.hour, participants: [person.name, partner?.name].filter(Boolean),
    summary: `🏗 ${person.name} is planning to build a ${person.buildProject.type}!`, type: 'building' });
  setEmote(person, 'sparkle', 20);
  person.thought = `I'm going to build a ${person.buildProject.type}!`;
  return person.buildProject;
}

async function startBuildProject(person, state) {
  if (person.buildProject) return; // already building
  const partner = person.partner ? state.people.find(p => p.name === person.partner) : null;
  let plan = null;
  try {
    const { generateBuildPlan } = await import('./ai.js');
    plan = await generateBuildPlan(person, partner, state);
  } catch { /* LLM unavailable — fall through to deterministic plan */ }
  // The villager already decided to build; an LLM hiccup must not lose that.
  if (!plan) plan = defaultBuildPlan(person);
  // guard against a race where the project landed (or person died) during await
  if (person.buildProject || person.alive === false) return;
  createBuildProject(person, partner, state, plan);
}

// God power: force a chosen villager to begin building immediately, skipping the
// LLM decision/plan entirely. Deterministic — for demoing the mechanic on demand.
export function godStartBuild(state, personIndex) {
  const person = state.people?.[personIndex];
  if (!person || person.alive === false || person.isAvatar) return state;
  if (person.buildProject) return state; // already building
  const partner = person.partner ? state.people.find(p => p.name === person.partner) : null;
  createBuildProject(person, partner, state, defaultBuildPlan(person));
  return state;
}
