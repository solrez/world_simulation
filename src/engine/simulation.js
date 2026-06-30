import { PERSONALITIES, LOCATIONS, RELATIONSHIP_STAGES, LIFE_STAGES, CHILD_NAMES, AMBIENT_EVENTS, YEARS_PER_DAY, TICKS_PER_DAY, GESTATION_DAYS, CONCEPTION_CHANCE, FOOD_TYPES, SEASON_ABUNDANCE, FARM, FRAILTY_PER_DAY, HEALTH_REGEN_PER_DAY, INJURY_HEAL_PER_DAY, HEALER_HEAL_BONUS, FRAILTY_SPEED_PENALTY, INJURY_SPEED_PENALTY, RESOURCE_NODES, DISCOVERY, SCHEMA_VERSION, buildMaterialCatalog } from '../utils/constants.js';
import { clearCompletedGoal } from './goals.js';
import { simlog } from './log.js';
import { blankTechMetrics, summarizeTech } from './tech/metrics.js';
import { getTimeOfDay, distBetween, locationAt, clamp, moveToward, setGoal, goToLocation, goToPerson } from './movement.js';
import { addMemory, decayMemories, personValence, setEmote } from './memory.js';
import { reassignFlakyModels } from './models.js';
import { addFood, totalFood, patchYield, depletePatch, depleteGrove, regrowPatches, updatePond, growField } from './food.js';
import { blankReputation, bumpReputation, decayReputation } from './reputation.js';
import { rewardAction, topSkill, bestSpecialist } from './q.js';
import { generateTerrain } from './terrain.js';
import { gainSkill } from './skills.js';
import { spawnInitialWildlife, updateWildlife, processHunting } from './wildlife.js';
import { cloneRecipeCatalog, recipeFor } from './catalog.js';
import { processDiscovery, processPrototype, processTechObservation, attemptableTech, recomputeTechEffects } from './tech.js';
import { blankRel } from './avatar.js';
import { updateNeeds, updateMoodFromNeeds, updateJealousy, processFoodSharing, processTrade, escalationGate, applyReflex, sleepNow, shareHomeWithPartner } from './needs.js';
import { getLifeStage, initPerson, initRelationships, canBeAttracted } from './person.js';
import { pickTarget, pickExploreTarget } from './scheduler.js';

// Re-exported from ./tech.js to preserve the engine's public API surface.
export { runIdeation } from './tech.js';

// Re-exported from ./avatar.js to preserve the engine's public API surface.
export { spawnAvatar, despawnAvatar, getAvatar, moveAvatar, avatarSpeak, performAvatarMiracle, endAvatarConversation } from './avatar.js';

// Re-exported from ./build.js to preserve the engine's public API surface.
export { godStartBuild } from './build.js';

// Re-exported from ./conversation.js to preserve the engine's public API surface.
export { findConversationGroup, runConversation, runAIAction } from './conversation.js';

// Re-exported from ./archive.js to preserve the engine's public API surface.
export { getConversationArchive, getConversationArchiveFromDisk, downloadConversationArchive, downloadFullWorldState } from './archive.js';

// ── Person ──

let nextPersonId = 100;

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
