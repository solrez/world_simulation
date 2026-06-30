// ── Person construction & initial relationships ──
// Builds a fresh villager object (needs, skills, inventory, tech state, ambitions)
// and seeds the initial relationship web. Also the life-stage lookup, the daily
// schedule slot table, and the attraction-eligibility rule. A pure provider —
// consumed by createSimulation, the scheduler (SCHEDULE), and the lifecycle.

import { PERSONALITIES, LOCATIONS, LIFE_STAGES, RELATIONSHIP_STAGES, FRAILTY_START_AGE, FRAILTY_PER_DAY } from '../utils/constants.js';
import { pickModelWeighted, chronotypeFor } from './models.js';

export function getLifeStage(age) {
  if (age < 3) return LIFE_STAGES.BABY;
  if (age < 13) return LIFE_STAGES.CHILD;
  if (age < 18) return LIFE_STAGES.TEEN;
  if (age < 55) return LIFE_STAGES.ADULT;
  return LIFE_STAGES.ELDER;
}

// daily schedule slots
export const SCHEDULE = {
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

export function generateAmbitions() {
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

export function initPerson(config, index, startX, startY) {
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

export function initRelationships(people) {
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

export function canBeAttracted(a, b) {
  if (a.lifeStage === LIFE_STAGES.BABY || a.lifeStage === LIFE_STAGES.CHILD) return false;
  if (b.lifeStage === LIFE_STAGES.BABY || b.lifeStage === LIFE_STAGES.CHILD) return false;
  if (a.parents.includes(b.name) || b.parents.includes(a.name)) return false;
  return true;
}
