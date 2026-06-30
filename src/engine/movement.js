// ── Movement, time-of-day, and spatial leaf utilities ──
// Pure helpers with no cross-engine dependencies (only constants + pathfinding).
// Shared by nearly every other engine module, so they live here at the bottom of
// the dependency graph.

import { LOCATIONS, MAP_W, MAP_H, CHRONOTYPE_OFFSET } from '../utils/constants.js';
import { buildWalkableGrid, findPath, nearestWalkable } from './pathfinding.js';

export function getTimeOfDay(hour) {
  if (hour < 6) return 'night';
  if (hour < 10) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 18) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

// The schedule slot a person is on RIGHT NOW, after shifting the world clock by
// their chronotype. An early-riser experiences "morning/work" before dawn; a
// night-owl is still in "free/social" when others have gone to sleep.
export function personTimeOfDay(person, state) {
  const off = CHRONOTYPE_OFFSET[person.chronotype] ?? 0;
  const h = (((state.hour + (state.minute || 0) / 60) - off) % 24 + 24) % 24;
  return getTimeOfDay(h);
}

export function distBetween(a, b) { return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2); }

export function locationAt(x, y) {
  for (const [, loc] of Object.entries(LOCATIONS))
    if (Math.abs(x - loc.x) < 2 && Math.abs(y - loc.y) < 2) return loc.name;
  return 'village';
}

export function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// Walkable grid is cached per simulation state and (re)built when terrain or
// the building set changes. Movement routes around water via A*.
export function getWalkableGrid(state) {
  if (!state._walkGrid) state._walkGrid = buildWalkableGrid(state.terrain);
  return state._walkGrid;
}

export function moveToward(person, tx, ty, state) {
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

export function setGoal(person, type, target, duration) {
  person.currentGoal = { type, target: target || null, until: duration || 30 };
}

export function goToLocation(person, locName) {
  const loc = Object.values(LOCATIONS).find(l => l.name.toLowerCase().includes(locName.toLowerCase()));
  if (loc) {
    person.targetX = loc.x + (Math.random() - 0.5) * 2;
    person.targetY = loc.y + (Math.random() - 0.5) * 2;
    person.targetX = clamp(person.targetX, 1, MAP_W - 2);
    person.targetY = clamp(person.targetY, 1, MAP_H - 2);
  }
}

export function goToPerson(person, target) {
  person.targetX = target.x + (Math.random() - 0.5) * 1;
  person.targetY = target.y + (Math.random() - 0.5) * 1;
}
