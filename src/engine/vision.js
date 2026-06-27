// ── Vision / perception ──
//
// Agents don't have omniscient knowledge of the world. Each tick they "see"
// what's actually within their sight radius and not occluded by terrain (water
// blocks line of sight, like looking across a lake vs through it). This is what
// makes roaming animals interesting: prey must be SPOTTED, and since the world
// is read live each tick, a hunter chases the animal's real position — not a
// stale snapshot. No ML here, just deterministic spatial perception.

import { MAP_W, MAP_H, TERRAIN } from '../utils/constants.js';

export const SIGHT_RADIUS = 7;       // tiles an agent can see in open ground
export const SIGHT_RADIUS_NIGHT = 4; // vision shrinks at night

// distance helper (tile space)
function dist(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

// Line-of-sight: walk a ray from (x0,y0) to (x1,y1); blocked if it crosses a
// water tile before reaching the target. Bresenham-style integer stepping.
export function hasLineOfSight(terrain, x0, y0, x1, y1) {
  let cx = Math.round(x0), cy = Math.round(y0);
  const tx = Math.round(x1), ty = Math.round(y1);
  const dx = Math.abs(tx - cx), dy = Math.abs(ty - cy);
  const sx = cx < tx ? 1 : -1, sy = cy < ty ? 1 : -1;
  let err = dx - dy;
  let guard = 0;
  while (guard++ < MAP_W + MAP_H) {
    if (cx === tx && cy === ty) return true;
    // a blocker between the two endpoints occludes (the endpoints themselves,
    // e.g. a fishing spot ON the shore, don't block their own visibility)
    if (!(cx === Math.round(x0) && cy === Math.round(y0))) {
      const tile = terrain[cy]?.[cx];
      if (tile && tile.type === TERRAIN.WATER) return false;
    }
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
    if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) return false;
  }
  return false;
}

// What can this person perceive right now? Returns live references (not copies)
// so callers chase real positions. Everything is filtered by radius + LOS.
export function perceive(person, state) {
  const radius = state.timeOfDay === 'night' ? SIGHT_RADIUS_NIGHT : SIGHT_RADIUS;
  const r2 = radius; // compared against euclidean distance below
  const terrain = state.terrain;

  const visibleAnimals = [];
  for (const a of state.wildlife || []) {
    if (!a.alive) continue;
    if (dist(person.x, person.y, a.x, a.y) > r2) continue;
    if (!hasLineOfSight(terrain, person.x, person.y, a.x, a.y)) continue;
    visibleAnimals.push(a);
  }

  const visiblePeople = [];
  for (const o of state.people || []) {
    if (o.name === person.name || o.alive === false) continue;
    if (dist(person.x, person.y, o.x, o.y) > r2) continue;
    if (!hasLineOfSight(terrain, person.x, person.y, o.x, o.y)) continue;
    visiblePeople.push(o);
  }

  return { radius, animals: visibleAnimals, people: visiblePeople };
}

// Nearest visible animal, optionally filtered (e.g. skip dangerous prey when
// unskilled). Returns null if nothing huntable is in sight.
export function nearestVisiblePrey(person, state, { allowDangerous = true } = {}) {
  const seen = perceive(person, state).animals;
  let best = null, bestD = Infinity;
  for (const a of seen) {
    if (!allowDangerous && a.dangerous) continue;
    const d = dist(person.x, person.y, a.x, a.y);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}
