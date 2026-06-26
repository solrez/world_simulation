import { PERSONALITIES, LOCATIONS, MAP_W, MAP_H, TERRAIN, RELATIONSHIP_STAGES, LIFE_STAGES, MOOD_LOCATIONS, CHILD_NAMES, SKILLS, AMBIENT_EVENTS, BUILD_REQUIREMENTS, BUILD_PHASES, WILDLIFE_TYPES, MEMORY_VALENCE, MEMORY_HALF_LIFE_GOOD, MEMORY_HALF_LIFE_BAD, MEMORY_MIN_WEIGHT, MEMORY_LOCATION_SENSITIVITY, GATE } from '../utils/constants.js';
import { buildWalkableGrid, findPath, nearestWalkable } from './pathfinding.js';
import { generateGroupDialogue, generateAction } from './ai.js';

// ── Conversation Archive (persisted to localStorage) ──

const ARCHIVE_KEY = 'village_life_conversation_archive';

function saveConversationToArchive(record) {
  // save to localStorage as backup
  try {
    const existing = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');
    existing.push(record);
    if (existing.length > 500) existing.splice(0, existing.length - 500);
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(existing));
  } catch (e) {
    console.warn('localStorage save failed:', e);
  }

  // save to disk via server API (appends to data/conversations.jsonl)
  fetch('/api/save-conversation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  }).catch(() => {}); // silent fail if server not available
}

export function getConversationArchive() {
  try {
    return JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');
  } catch { return []; }
}

export async function getConversationArchiveFromDisk() {
  try {
    const resp = await fetch('/api/conversations');
    if (resp.ok) return resp.json();
  } catch {}
  return getConversationArchive(); // fallback to localStorage
}

export function downloadConversationArchive() {
  // fetch from disk first, fallback to localStorage
  fetch('/api/conversations')
    .then(r => r.ok ? r.json() : getConversationArchive())
    .catch(() => getConversationArchive())
    .then(archive => {
      const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `village_conversations_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
}

export function downloadFullWorldState(gameState) {
  const data = {
    exportDate: new Date().toISOString(),
    people: gameState.people.map(p => ({
      name: p.name, gender: p.gender, age: p.age, alive: p.alive,
      traits: p.traits, values: p.values, background: p.background,
      mood: p.mood, partner: p.partner, children: p.children, parents: p.parents,
      skills: p.skills, inventory: p.inventory,
      memories: p.memories, conversationLog: p.conversationLog,
      relationships: Object.fromEntries(
        Object.entries(p.relationships).map(([name, r]) => [name, { stage: r.stage, affection: r.affection, trust: r.trust, attraction: r.attraction, familiarity: r.familiarity }])
      ),
      ambitions: p.ambitions,
    })),
    stats: gameState.stats,
    day: gameState.day, season: gameState.season,
    villageFood: gameState.villageFood,
    buildings: gameState.buildings,
    events: gameState.events.slice(-50),
  };

  // save to disk
  fetch('/api/save-world', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(() => {});

  // also download
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `village_world_state_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Terrain ──

function generateTerrain() {
  const map = [];
  for (let y = 0; y < MAP_H; y++) {
    const row = [];
    for (let x = 0; x < MAP_W; x++) {
      let type = TERRAIN.GRASS;
      const px = x - 24, py = y - 15;
      if (px * px + py * py < 6) type = TERRAIN.WATER;
      const dx = x - 14, dy = y - 10;
      if (Math.sqrt(dx * dx + dy * dy) < 1.5) type = TERRAIN.DIRT;
      if (y === 10 && x >= 12 && x <= 16) type = TERRAIN.PATH;
      if (x === 14 && y >= 8 && y <= 12) type = TERRAIN.PATH;
      if ((x + y * 7) % 13 === 0 && type === TERRAIN.GRASS) type = TERRAIN.FLOWERS;
      row.push({ type, variant: (x * 31 + y * 17) % 3 });
    }
    map.push(row);
  }
  const pathPairs = [
    [LOCATIONS.CAMPFIRE, LOCATIONS.WELL], [LOCATIONS.CAMPFIRE, LOCATIONS.TREE_GROVE],
    [LOCATIONS.CAMPFIRE, LOCATIONS.MEADOW], [LOCATIONS.WELL, LOCATIONS.POND],
    [LOCATIONS.CAMPFIRE, LOCATIONS.ROCK_SEAT], [LOCATIONS.CAMPFIRE, LOCATIONS.BERRY_BUSH],
    [LOCATIONS.WELL, LOCATIONS.FISHING_SPOT],
  ];
  for (const [a, b] of pathPairs) {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ppx = Math.round(a.x + (b.x - a.x) * t);
      const ppy = Math.round(a.y + (b.y - a.y) * t);
      if (ppx >= 0 && ppx < MAP_W && ppy >= 0 && ppy < MAP_H && map[ppy][ppx].type !== TERRAIN.WATER)
        map[ppy][ppx].type = TERRAIN.PATH;
    }
  }
  return map;
}

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

function generateAmbitions(config) {
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
  const angle = (index / 4) * Math.PI * 2;
  const dist = 3 + Math.random() * 5;
  return {
    ...config,
    id: config.id ?? index,
    x: startX ?? (cf.x + Math.cos(angle) * dist),
    y: startY ?? (cf.y + Math.sin(angle) * dist),
    targetX: null, targetY: null,
    path: null, _pathDest: null,
    currentLocation: 'village',
    lifeStage: getLifeStage(config.age),
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
    skills: { fishing: 0, building: 0, foraging: 0, storytelling: 0, healing: 0, crafting: 0 },
    // alive
    alive: true,
    // ambitions — generated at init
    ambitions: generateAmbitions(config),
    // grief
    griefTimer: 0,
    griefTarget: null,
    // illness
    sick: false,
    sickTimer: 0,
    // favorite location
    favoriteLocation: null,
    // inventory
    inventory: { food: 5, wood: 0, stone: 0, thatch: 0 },
    // crafted tools that boost gathering yields, plus in-progress craft state
    tools: {},
    craftTool: null,
    craftProgress: 0,
    foodGathered: 0,
    // social
    flirting: null,
    // awe — sense of higher power
    awe: 0,
    // building project
    buildProject: null,
    // conversation log — actual past dialogues stored per person
    conversationLog: [], // [{participants: [], lines: [{speaker, text}], day, location}]
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

export function createSimulation() {
  const terrain = generateTerrain();
  const people = PERSONALITIES.map((p, i) => initPerson(p, i));
  initRelationships(people);
  return {
    terrain, people, buildings: [],
    wildlife: spawnInitialWildlife(),
    day: 1, hour: 8, minute: 0,
    timeOfDay: 'morning', weather: 'clear',
    season: 'spring',
    villageFood: 50,
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

  // respawn animals occasionally
  if (state.tick % 500 === 0) {
    const aliveCount = state.wildlife.filter(w => w.alive).length;
    if (aliveCount < 5) {
      const types = ['rabbit', 'deer', 'bird'];
      const type = types[Math.floor(Math.random() * types.length)];
      state.wildlife.push(createAnimal(type, Math.random() * MAP_W, Math.random() * MAP_H));
    }
  }
}

// ── Helpers ──

function getTimeOfDay(hour) {
  if (hour < 6) return 'night';
  if (hour < 10) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 18) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}
function distBetween(a, b) { return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2); }
function locationAt(x, y) {
  for (const [, loc] of Object.entries(LOCATIONS))
    if (Math.abs(x - loc.x) < 2 && Math.abs(y - loc.y) < 2) return loc.name;
  return 'village';
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// Walkable grid is cached per simulation state and (re)built when terrain or
// the building set changes. Movement routes around water via A*.
function getWalkableGrid(state) {
  if (!state._walkGrid) state._walkGrid = buildWalkableGrid(state.terrain);
  return state._walkGrid;
}

function moveToward(person, tx, ty, state) {
  const dist = Math.sqrt((tx - person.x) ** 2 + (ty - person.y) ** 2);
  if (dist < 0.5) { person.targetX = null; person.targetY = null; person.path = null; return true; }
  const spd = person.tiredness > 80 ? person.speed * 0.7 : person.speed;

  // (Re)compute an A* path when the destination changes. Without a state/grid
  // (e.g. legacy callers) fall back to straight-line movement.
  const grid = state ? getWalkableGrid(state) : null;
  if (grid) {
    const destKey = `${Math.round(tx)},${Math.round(ty)}`;
    if (person._pathDest !== destKey) {
      person._pathDest = destKey;
      person.path = findPath(grid, { x: person.x, y: person.y }, { x: tx, y: ty });
    }
    if (person.path && person.path.length) {
      // steer toward the next waypoint tile centre; pop it once reached
      const wp = person.path[0];
      const wdx = wp.x - person.x, wdy = wp.y - person.y;
      const wd = Math.sqrt(wdx * wdx + wdy * wdy);
      if (wd < 0.4) { person.path.shift(); return false; }
      person.x += (wdx / wd) * spd;
      person.y += (wdy / wd) * spd;
      return false;
    }
    // path is empty (already at goal tile) or null (unreachable) → home in on the
    // exact target, but only across walkable ground.
  }

  // final approach / fallback: straight line toward the exact target
  const dx = tx - person.x, dy = ty - person.y;
  const nx = person.x + (dx / dist) * spd, ny = person.y + (dy / dist) * spd;
  if (!grid || nearestWalkable(grid, nx, ny)) {
    // only step if the destination tile is walkable (or no grid available)
    const tileWalkable = !grid || grid[Math.round(ny)]?.[Math.round(nx)];
    if (tileWalkable) { person.x = nx; person.y = ny; }
  }
  return false;
}

function setGoal(person, type, target, duration) {
  person.currentGoal = { type, target: target || null, until: duration || 30 };
}

function goToLocation(person, locName) {
  const loc = Object.values(LOCATIONS).find(l => l.name.toLowerCase().includes(locName.toLowerCase()));
  if (loc) {
    person.targetX = loc.x + (Math.random() - 0.5) * 2;
    person.targetY = loc.y + (Math.random() - 0.5) * 2;
    person.targetX = clamp(person.targetX, 1, MAP_W - 2);
    person.targetY = clamp(person.targetY, 1, MAP_H - 2);
  }
}

function goToPerson(person, target) {
  person.targetX = target.x + (Math.random() - 0.5) * 1;
  person.targetY = target.y + (Math.random() - 0.5) * 1;
}

function pickTarget(person, people, state) {
  const schedule = SCHEDULE[state.timeOfDay] || 'free';

  // daily routine drives behavior
  switch (schedule) {
    case 'sleep':
      if (person.tiredness > 30) return; // let needsDriven handle sleep
      // night owls might wander
      if (person.traits.includes('restless') || Math.random() < 0.2) {
        goToLocation(person, 'Campfire');
        setGoal(person, 'wander', null, 20);
      }
      return;

    case 'work':
      // go gather resources, explore, or build
      if (Math.random() < 0.5) {
        const workLocs = ['Berry Bush', 'Fishing Spot', 'Grove', 'Well'];
        const loc = weightedLocationPick(person, workLocs);
        goToLocation(person, loc);
        person.activity = 'working';
        setGoal(person, 'work', loc, 40);
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

function addMemory(person, text, type, day, opts = {}) {
  const valence = opts.valence ?? MEMORY_VALENCE[type] ?? 0;
  const location = opts.location ?? null;
  person.memories.push({ text, type, day, valence, location, weight: Math.abs(valence) });
  if (person.memories.length > 30) person.memories.shift();
}

// Decay memory weights toward zero over days and prune faded ones. Cheap —
// called once per game-day, not per tick.
function decayMemories(person, state) {
  if (!person.memories?.length) return;
  person.memories = person.memories.filter(m => {
    if (m.valence === undefined) return true; // legacy memory, never anchored
    const ageDays = Math.max(0, state.day - m.day);
    const halfLife = m.valence < 0 ? MEMORY_HALF_LIFE_BAD : MEMORY_HALF_LIFE_GOOD;
    m.weight = Math.abs(m.valence) * Math.pow(0.5, ageDays / halfLife);
    return m.weight >= MEMORY_MIN_WEIGHT;
  });
}

// Signed feeling about a place: sum of decayed weights * sign(valence) over
// memories anchored to that location. Positive = drawn to it, negative = avoid.
function locationValence(person, locName) {
  if (!person.memories?.length) return 0;
  let sum = 0;
  for (const m of person.memories) {
    if (m.location === locName && m.valence) sum += m.weight * Math.sign(m.valence);
  }
  return sum;
}

// Signed feeling about another person, by name, from memories that mention them.
function personValence(person, otherName) {
  if (!person.memories?.length || !otherName) return 0;
  let sum = 0;
  for (const m of person.memories) {
    if (m.valence && m.text && m.text.includes(otherName)) sum += m.weight * Math.sign(m.valence);
  }
  return sum;
}

// Softmax over candidate location names weighted by the person's feelings about
// each. A strong aversion sharply downweights but never hard-bans a place;
// a fond memory upweights it. With no memories this is a uniform random pick.
function weightedLocationPick(person, names) {
  if (!names?.length) return null;
  if (!person.memories?.length) return names[Math.floor(Math.random() * names.length)];
  const weights = names.map(n => Math.exp(locationValence(person, n) * MEMORY_LOCATION_SENSITIVITY));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return names[Math.floor(Math.random() * names.length)];
  let r = Math.random() * total;
  for (let i = 0; i < names.length; i++) {
    r -= weights[i];
    if (r <= 0) return names[i];
  }
  return names[names.length - 1];
}

function setEmote(person, emote, duration) {
  person.emote = emote;
  person.emoteTimer = duration || 25;
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
    person.tiredness = clamp(person.tiredness - 0.2, 0, 100);  // ~6 hrs to fully rest
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
  if (person.conversationId || person.sleeping || person.eating) return { verdict: 'IDLE' };
  if (person.lifeStage === LIFE_STAGES.BABY) return { verdict: 'IDLE' };
  if (person.currentGoal && person.currentGoal.until > 0) return { verdict: 'IDLE' };

  // ── reflexes: single-answer survival, handled locally ──
  if (person.tiredness > GATE.EXHAUSTED) return { verdict: 'REFLEX', reflex: 'sleep' };
  if (state.timeOfDay === 'night' && person.tiredness > GATE.NIGHT_TIRED && !person.targetX) {
    return { verdict: 'REFLEX', reflex: 'sleep' };
  }
  if (person.sick && person.tiredness > GATE.SICK_TIRED) return { verdict: 'REFLEX', reflex: 'sleep' };
  if (person.hunger > GATE.STARVING) return { verdict: 'REFLEX', reflex: 'eat' };
  if (state.weather === 'storm') return { verdict: 'REFLEX', reflex: 'shelter' };

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
    if (state.villageFood < 20 && (person.inventory.food || 0) < 5 && Math.random() < 0.1) {
      return { verdict: 'ESCALATE' };
    }
  }

  return { verdict: 'IDLE' };
}

// Apply a single-answer reflex locally — no LLM, no discretion.
function applyReflex(person, reflex, state) {
  switch (reflex) {
    case 'sleep': {
      person.sleeping = true;
      person.activity = 'sleeping';
      person.targetX = null; person.targetY = null;
      setEmote(person, 'zzz', 999);
      setGoal(person, 'sleep', null, person.sick ? 200 : 500);
      if (person.home) { person.targetX = person.home.x; person.targetY = person.home.y; }
      break;
    }
    case 'eat': {
      if (person.inventory.food > 0) {
        person.inventory.food--;
        person.hunger = clamp(person.hunger - 25, 0, 100);
        person.eating = true; person.activity = 'eating';
        setEmote(person, 'eat', 30); setGoal(person, 'eat', null, 30);
      } else if (state.villageFood > 5) {
        state.villageFood -= 2;
        person.hunger = clamp(person.hunger - 20, 0, 100);
        person.eating = true; person.activity = 'eating';
        setEmote(person, 'eat', 30); setGoal(person, 'eat', null, 30);
      } else {
        const foodLocs = Object.values(LOCATIONS).filter(l => l.type === 'food');
        const loc = weightedLocationPick(person, foodLocs.map(l => l.name));
        if (loc) { goToLocation(person, loc); person.activity = 'gathering'; setGoal(person, 'work', loc, 100); }
      }
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
  if (person.sleeping || person.eating || (person.inventory.food || 0) <= 3) return;
  for (const other of people) {
    if (other.name === person.name || other.alive === false || other.hunger < 50) continue;
    if (distBetween(person, other) > 4) continue;
    const rel = person.relationships[other.name];
    if (!rel) continue;
    if (person.partner === other.name || rel.affection > 55 || rel.attraction > 60) {
      person.inventory.food -= 2;
      other.inventory.food += 2;
      other.hunger = clamp(other.hunger - 15, 0, 100);
      setEmote(person, 'heart', 15);
      rel.affection = clamp(rel.affection + 2, 0, 100);
      const otherRel = other.relationships[person.name];
      if (otherRel) otherRel.affection = clamp(otherRel.affection + 3, 0, 100);
      addMemory(other, `${person.name} shared food with me`, 'kindness', state.day, { location: other.currentLocation });
      person.thought = `I gave food to ${other.name}`;
      break;
    }
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

function processLifeEvents(person, people, state) {
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
      if (rel && rel.stage === RELATIONSHIP_STAGES.PARTNERED && state.day > 3 && Math.random() < 0.005) {
        person.pregnant = true;
        person.pregnancyTimer = 100;
        addMemory(person, `Expecting a child with ${partner.name}!`, 'life', state.day);
        addMemory(partner, `${person.name} is expecting our child!`, 'life', state.day);
        setEmote(person, 'sparkle', 40);
        state.events.push({ day: state.day, hour: state.hour, participants: [person.name, partner.name], summary: `${person.name} is expecting!`, type: 'pregnancy' });
      }
    }
  }

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

  if (state.tick % 600 === 0 && state.tick > 0) {
    person.age++;
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
      bp.progress = (bp.progress || 0) + 1 + (person.skills.building || 0) * 0.02;
      person.activity = 'building';
      person.skills.building = Math.min(100, (person.skills.building || 0) + 0.05);

      const totalNeeded = mn.wood + mn.stone + mn.thatch;
      const progressTarget = totalNeeded * 3; // takes ~3 work-ticks per material unit

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
        addMemory(person, `Finished building a ${bp.type}${partner ? ` with ${partner.name}` : ''}!`, 'life', state.day);
        state.events.push({ day: state.day, hour: state.hour, participants: [person.name, partner?.name].filter(Boolean), summary: `🏠 ${person.name} completed a ${bp.type}!`, type: 'building' });
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
  }, nextPersonId++, mother.x, mother.y);
  child.parents = [mother.name, father?.name].filter(Boolean);
  mother.children.push(name);
  if (father) father.children.push(name);
  addMemory(mother, `Gave birth to ${name}`, 'life', state.day);
  if (father) addMemory(father, `${name} was born`, 'life', state.day);
  return child;
}

// ── Main tick ──

export function simulateTick(state) {
  if (state.paused) return state;
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

  const alivePeople = next.people.filter(p => p.alive !== false);

  for (const person of next.people) {
    if (person.alive === false) continue;

    if (person.conversationCooldown > 0) person.conversationCooldown--;
    if (person.actionCooldown > 0) person.actionCooldown--;
    if (person.gateCooldown > 0) person.gateCooldown--;
    if (person.emoteTimer > 0) { person.emoteTimer--; if (person.emoteTimer <= 0) person.emote = null; }
    if (person.currentGoal) {
      person.currentGoal.until--;
      if (person.currentGoal.until <= 0) person.currentGoal = null;
    }

    updateNeeds(person, next.timeOfDay, next.weather);
    updateMoodFromNeeds(person);
    updateJealousy(person, alivePeople);
    updateSkills(person);
    if (dayRolled) decayMemories(person, next);
    processBreakups(person, alivePeople, next);
    processIllness(person, next);
    processGrief(person);
    processAmbitions(person, next);
    processPersonalityConflict(person, alivePeople, next);

    for (const otherName of Object.keys(person.relationships))
      updateRelationshipStage(person, otherName, alivePeople);

    processLifeEvents(person, next.people, next);
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
    if (person.eating) {
      const curLoc = locationAt(person.x, person.y);
      const foodLocs = Object.values(LOCATIONS).filter(l => l.type === 'food');
      if (!foodLocs.some(l => l.name === curLoc) && person.targetX === null) person.eating = false;
      continue;
    }

    processFoodSharing(person, alivePeople, next);

    const gate = escalationGate(person, alivePeople, next);
    if (gate.verdict === 'REFLEX') {
      applyReflex(person, gate.reflex, next);
    } else if (gate.verdict === 'ESCALATE') {
      person.pendingLLM = true; // the AI interval will pick this person up
      // leave the slot open for the LLM — don't run the local schedule this tick
    }

    if (person.targetX !== null) {
      const arrived = moveToward(person, person.targetX, person.targetY, next);
      if (arrived) {
        person.currentLocation = locationAt(person.x, person.y);
        person.idle = 0;
        if (person.hunger > 40) {
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
  processResources(next);

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

function updateSkills(person) {
  const loc = person.currentLocation;
  const tools = person.tools || {};

  // food gathering
  if (person.activity === 'working' || person.activity === 'gathering') {
    if (loc === 'Fishing Spot') {
      person.skills.fishing = Math.min(100, person.skills.fishing + 0.02);
      const chance = (0.005 + person.skills.fishing * 0.0003) * (tools.fishing_rod ? 1.6 : 1);
      if (Math.random() < chance) {
        const amount = 1 + Math.floor(person.skills.fishing / 25);
        person.inventory.food += amount;
        person.foodGathered += amount;
        person.thought = `Caught ${amount} fish!`;
      }
    } else if (loc === 'Berry Bush') {
      person.skills.foraging = Math.min(100, person.skills.foraging + 0.02);
      const chance = (0.005 + person.skills.foraging * 0.0003) * (tools.forage_basket ? 1.6 : 1);
      if (Math.random() < chance) {
        const amount = 1 + Math.floor(person.skills.foraging / 25);
        person.inventory.food += amount;
        person.foodGathered += amount;
        person.thought = `Found ${amount} berries!`;
      }
    }
  }

  // chopping wood at Grove
  if ((person.activity === 'chopping' || person.activity === 'working') && loc === 'Grove') {
    person.skills.building = Math.min(100, person.skills.building + 0.02);
    if (Math.random() < (0.004 + person.skills.building * 0.0002) * (tools.axe ? 1.6 : 1)) {
      person.inventory.wood++;
      person.thought = `Chopped a log! (${person.inventory.wood} total)`;
      setEmote(person, 'sparkle', 8);
    }
  }

  // crafting a tool — progresses while activity is 'crafting'; faster with skill
  if (person.activity === 'crafting' && person.craftTool) {
    person.skills.crafting = Math.min(100, (person.skills.crafting || 0) + 0.05);
    person.craftProgress = (person.craftProgress || 0) + 1 + person.skills.crafting * 0.02;
    if (person.craftProgress >= 40) {
      person.tools = { ...(person.tools || {}), [person.craftTool]: true };
      const made = person.craftTool.replace('_', ' ');
      person.thought = `Finished crafting a ${made}!`;
      setEmote(person, 'sparkle', 12);
      addMemory(person, `Crafted a ${made}`, 'achievement', person._craftDay ?? 0, { location: person.currentLocation });
      person.craftTool = null;
      person.craftProgress = 0;
      person.activity = 'idle';
    }
  }

  // collecting stone at Rock Seat
  if ((person.activity === 'collecting' || person.activity === 'working') && loc === 'Rock Seat') {
    person.skills.building = Math.min(100, person.skills.building + 0.015);
    if (Math.random() < 0.003 + person.skills.building * 0.0002) {
      person.inventory.stone++;
      person.thought = `Found a good stone! (${person.inventory.stone} total)`;
    }
  }

  // gathering thatch at Meadow
  if ((person.activity === 'gathering' || person.activity === 'working') && loc === 'Meadow') {
    person.skills.foraging = Math.min(100, person.skills.foraging + 0.01);
    if (Math.random() < (0.005 + person.skills.foraging * 0.0003) * (tools.forage_basket ? 1.6 : 1)) {
      person.inventory.thatch++;
      person.thought = `Gathered thatch! (${person.inventory.thatch} total)`;
    }
  }

  // general building skill from construction activity
  if (person.activity === 'building') {
    person.skills.building = Math.min(100, person.skills.building + 0.03);
  }
  if (person.conversationId) {
    person.skills.storytelling = Math.min(100, person.skills.storytelling + 0.06);
    // good storytellers boost attraction
    if (person.skills.storytelling > 30) {
      // subtle attraction boost to conversation partners
      for (const [name, rel] of Object.entries(person.relationships)) {
        if (rel.familiarity > 10 && Math.random() < 0.005) {
          rel.attraction = Math.min(100, rel.attraction + 0.3);
        }
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

// ── Illness ──

function processIllness(person, state) {
  if (person.alive === false) return;

  // sick people recover over time
  if (person.sick) {
    person.sickTimer--;
    person.tiredness = Math.min(100, person.tiredness + 0.3);
    person.hunger = Math.min(100, person.hunger + 0.1);
    if (person.sickTimer <= 0) {
      person.sick = false;
      person.mood = 'content';
      addMemory(person, 'Recovered from illness', 'life', state.day, { location: person.currentLocation });
    }
    // healer nearby can speed recovery
    const alivePeople = state.people.filter(p => p.alive !== false && p.name !== person.name);
    for (const p of alivePeople) {
      if (p.skills.healing > 20 && distBetween(person, p) < 4) {
        person.sickTimer = Math.max(0, person.sickTimer - 1);
        p.skills.healing = Math.min(100, p.skills.healing + 0.15);
        if (!p.currentGoal) {
          p.activity = 'healing';
          setGoal(p, 'heal', person.name, 15);
        }
      }
    }
    // death from illness
    if (person.hunger > 95 && person.sick && Math.random() < 0.002) {
      killPerson(person, state, 'illness');
    }
    return;
  }

  // natural illness — more likely when hungry, tired, or in winter
  const winterMod = state.season === 'winter' ? 3 : 1;
  const exhaustionMod = person.tiredness > 70 ? 2 : 1;
  const hungerMod = person.hunger > 60 ? 2 : 1;
  if (Math.random() < 0.00004 * winterMod * exhaustionMod * hungerMod) {
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
    if (a.check(person)) {
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

function processResources(state) {
  // collect food from gatherers
  for (const p of state.people) {
    if (p.alive === false) continue;
    if (p.foodGathered > 0) {
      state.villageFood += p.foodGathered;
      p.foodGathered = 0;
    }
  }
  // village consumes food (1 per alive person per 250 ticks = ~4 game-hours)
  if (state.tick % 250 === 0) {
    const alive = state.people.filter(p => p.alive !== false).length;
    state.villageFood = Math.max(0, state.villageFood - alive);
  }
  // season affects food
  if (state.season === 'winter' && state.tick % 200 === 0) {
    state.villageFood = Math.max(0, state.villageFood - 1);
  }
  if (state.season === 'summer' && state.tick % 300 === 0) {
    state.villageFood += 2;
  }
  // famine warning
  if (state.villageFood <= 0) {
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

// ── Death (much rarer — scaled for 1-min ticks) ──

function processDeath(person, state) {
  if (person.alive === false) return;
  // old age — only elders, very rarely
  if (person.lifeStage === LIFE_STAGES.ELDER && Math.random() < 0.00005) {
    killPerson(person, state, 'old age');
  }
  // starvation — only after prolonged extreme hunger AND exhaustion
  if (person.hunger >= 98 && person.tiredness >= 95 && Math.random() < 0.001) {
    killPerson(person, state, 'exhaustion and starvation');
  }
  // accident (extremely rare)
  if (Math.random() < 0.000005) {
    killPerson(person, state, 'an accident');
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
      if (event.name === 'Storytelling Night') p.skills.storytelling = Math.min(100, p.skills.storytelling + 1);
      addMemory(p, `Joined the ${event.name} at the Campfire`, 'kindness', state.day, { location: 'Campfire' });
    }
    state.events.push({ day: state.day, hour: state.hour, participants: alivePeople.map(p => p.name), summary: `🎉 ${event.name}! ${event.desc}`, type: 'seasonal' });
  }

  // partner ceremony when new couple forms
  // (handled in relationship stage updates)
}

// ── Conversations ──

export function findConversationGroup(people) {
  const available = people.filter(p =>
    p.alive !== false && !p.conversationId && p.conversationCooldown <= 0 &&
    !p.sleeping && !p.eating && p.lifeStage !== LIFE_STAGES.BABY
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

  // shorter conversations — 2-4 lines per person
  const totalLines = participants.length * (2 + Math.floor(Math.random() * 3));
  let lastSpeakerIdx = -1;
  const speakCount = new Map(participants.map(p => [p.name, 0]));

  for (let t = 0; t < totalLines; t++) {
    let speakerIdx = pickNextSpeaker(participants, lastSpeakerIdx, speakCount, conversation.lines);
    const speaker = participants[speakerIdx];
    const others = participants.filter(p => p.name !== speaker.name);
    const cs = gameRef.current;
    const context = `${participants.length} people at ${conversation.location}. ${cs.timeOfDay}, day ${cs.day}. ${cs.weather}. ${
      conversation.lines.length === 0 ? 'They just gathered.' : ''
    }${speaker.partner ? ` ${speaker.name} is with ${speaker.partner}.` : ''}${
      speaker.hunger > 60 ? ` ${speaker.name} is hungry.` : ''}${speaker.tiredness > 60 ? ` Tired.` : ''}`;

    if (signal?.aborted) break;
    const result = await generateGroupDialogue(speaker, others, cs.people, context, history, signal);
    if (!result) { await new Promise(r => setTimeout(r, 800)); continue; }

    conversation.lines.push({
      speaker: speaker.name, text: result.dialogue, thought: result.internal_thought,
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

    const convos = gameRef.current.activeConversations.map(c =>
      c.id === convoId ? { ...conversation, lines: [...conversation.lines] } : c
    );
    gameRef.current = { ...gameRef.current, activeConversations: convos };
    onUpdate();

    if (!result.wants_to_continue && t >= participants.length * 2) {
      if (participants.length > 2) {
        speaker.conversationId = null;
        speaker.conversationCooldown = 10 + Math.floor(Math.random() * 10);
        speaker.activity = 'wandering';
        pickTarget(speaker, gameRef.current.people, gameRef.current);
        conversation.lines.push({ speaker: 'narrator', text: `${speaker.name} walks away.`, thought: null, mood: null });
        participants.splice(speakerIdx, 1);
        speakCount.delete(speaker.name);
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
  const result = await generateAction(person, cs.people, {
    timeOfDay: cs.timeOfDay, weather: cs.weather, day: cs.day,
    hour: cs.hour, minute: cs.minute,
    season: cs.season, villageFood: cs.villageFood,
    wildlife: cs.wildlife, buildings: cs.buildings,
  }, signal);
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
      person.sleeping = true;
      person.activity = 'sleeping';
      setEmote(person, 'zzz', 200);
      setGoal(person, 'sleep', null, 400);
      if (person.home) { person.targetX = person.home.x; person.targetY = person.home.y; }
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
      // find nearest alive animal of the target type (or any)
      const prey = cs.wildlife.find(w =>
        w.alive && (!target || w.type.toLowerCase().includes(target.toLowerCase()))
      );
      if (prey) {
        person.targetX = prey.x;
        person.targetY = prey.y;
        person.activity = 'hunting';
        setGoal(person, 'hunt', prey.type, 80);
        // attempt to catch if close enough
        if (distBetween(person, prey) < 2) {
          const huntSkill = person.skills?.hunting || 0;
          const catchChance = 0.1 + huntSkill * 0.003;
          if (Math.random() < catchChance) {
            prey.alive = false;
            person.inventory.food += prey.foodValue;
            person.foodGathered += prey.foodValue;
            person.skills.hunting = Math.min(100, (person.skills.hunting || 0) + 1);
            setEmote(person, 'sparkle', 20);
            addMemory(person, `Caught a ${prey.type}! Got ${prey.foodValue} food.`, 'achievement', cs.day, { location: person.currentLocation });
            cs.events.push({ day: cs.day, hour: cs.hour, participants: [person.name], summary: `🏹 ${person.name} caught a ${prey.type}!`, type: 'hunt' });
          }
        }
      } else {
        person.thought = 'No animals around to hunt...';
        goToLocation(person, 'Grove');
        person.activity = 'exploring';
        setGoal(person, 'explore', null, 40);
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
async function startBuildProject(person, state) {
  const { generateBuildPlan } = await import('./ai.js');
  const partner = person.partner ? state.people.find(p => p.name === person.partner) : null;
  const plan = await generateBuildPlan(person, partner, state);
  if (!plan) return;

  const hx = LOCATIONS.CAMPFIRE.x + (Math.random() - 0.5) * 14;
  const hy = LOCATIONS.CAMPFIRE.y + (Math.random() - 0.5) * 10;
  // snap to dry, walkable land so homes never spawn in water
  const grid = getWalkableGrid(state);
  const dry = nearestWalkable(grid, clamp(hx, 3, MAP_W - 4), clamp(hy, 3, MAP_H - 4))
    || { x: LOCATIONS.CAMPFIRE.x, y: LOCATIONS.CAMPFIRE.y };
  const site = { x: dry.x, y: dry.y };

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

  addMemory(person, `Planning to build a ${plan.type}`, 'life', state.day);
  state.events.push({ day: state.day, hour: state.hour, participants: [person.name, partner?.name].filter(Boolean),
    summary: `🏗 ${person.name} is planning to build a ${plan.type}!`, type: 'building' });
  setEmote(person, 'sparkle', 20);
  person.thought = `I'm going to build a ${plan.type}!`;
}
