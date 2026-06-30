import { PERSONALITIES, LOCATIONS, RELATIONSHIP_STAGES, LIFE_STAGES, SEASON_ABUNDANCE, FARM, RESOURCE_NODES, DISCOVERY, SCHEMA_VERSION, buildMaterialCatalog } from '../utils/constants.js';
import { clearCompletedGoal } from './goals.js';
import { getTimeOfDay, distBetween, locationAt, moveToward, setGoal, goToPerson } from './movement.js';
import { addMemory, decayMemories, setEmote } from './memory.js';
import { addFood, patchYield, depletePatch, depleteGrove } from './food.js';
import { blankReputation, bumpReputation } from './reputation.js';
import { rewardAction } from './q.js';
import { generateTerrain } from './terrain.js';
import { gainSkill } from './skills.js';
import { spawnInitialWildlife, updateWildlife, processHunting } from './wildlife.js';
import { cloneRecipeCatalog } from './catalog.js';
import { processDiscovery, processPrototype, processTechObservation } from './tech.js';
import { blankTechMetrics } from './tech/metrics.js';
import { updateNeeds, updateMoodFromNeeds, updateJealousy, processFoodSharing, processTrade, escalationGate, applyReflex, sleepNow, shareHomeWithPartner } from './needs.js';
import { initPerson, initRelationships, canBeAttracted } from './person.js';
import { pickTarget, pickExploreTarget } from './scheduler.js';
import { processLifeEvents, processAdultTeaching, processIllness, processGrief, processAmbitions, updateSeason, processResources, processPersonalityConflict, processFrailty, processDeath, processBreakups, processAmbientEvents, processSeasonalEvents } from './lifecycle.js';

// Re-exported from ./tech.js to preserve the engine's public API surface.
export { runIdeation } from './tech.js';

// Re-exported from ./lifecycle.js to preserve the engine's public API surface.
export { divineKill, resurrect } from './lifecycle.js';

// Re-exported from ./avatar.js to preserve the engine's public API surface.
export { spawnAvatar, despawnAvatar, getAvatar, moveAvatar, avatarSpeak, performAvatarMiracle, endAvatarConversation } from './avatar.js';

// Re-exported from ./build.js to preserve the engine's public API surface.
export { godStartBuild } from './build.js';

// Re-exported from ./conversation.js to preserve the engine's public API surface.
export { findConversationGroup, runConversation, runAIAction } from './conversation.js';

// Re-exported from ./archive.js to preserve the engine's public API surface.
export { getConversationArchive, getConversationArchiveFromDisk, downloadConversationArchive, downloadFullWorldState } from './archive.js';

// ── State ──

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

// ── Skills (gameplay effects of work) ──

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
