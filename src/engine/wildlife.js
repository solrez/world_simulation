// ── Wildlife ──
// Spawning, flocking/fleeing/attacking behaviour, population management, and the
// continuous active hunt that lets agents chase prey via live vision. Owns its
// own animal-id counter.

import {
  WILDLIFE_TYPES, MAP_W, MAP_H, TERRAIN, LOCATIONS,
  WILDLIFE_TARGETS, WILDLIFE_RESPAWN, SEASON_ABUNDANCE,
} from '../utils/constants.js';
import { nearestVisiblePrey } from './vision.js';
import { locationAt, distBetween, clamp, moveToward, goToLocation } from './movement.js';
import { addMemory, setEmote } from './memory.js';
import { addFood } from './food.js';
import { bumpReputation } from './reputation.js';
import { rewardAction } from './q.js';
import { gainSkill } from './skills.js';

let nextAnimalId = 1000;

export function spawnInitialWildlife() {
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

export function createAnimal(type, x, y) {
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

export function updateWildlife(state) {
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
export function processHunting(person, state) {
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
