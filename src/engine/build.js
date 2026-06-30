// ── Building projects ──
// Picking a buildable home site (walkable, dry, clear of resource nodes and other
// buildings), attaching a build project from an LLM-or-fallback plan, and the
// god power that forces one to start. Construction PROGRESS/completion lives in
// the lifecycle (processLifeEvents); this module just kicks projects off.

import { LOCATIONS, MAP_W, MAP_H } from '../utils/constants.js';
import { nearestWalkable } from './pathfinding.js';
import { clamp, getWalkableGrid } from './movement.js';
import { addMemory, setEmote } from './memory.js';

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

export async function startBuildProject(person, state) {
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
