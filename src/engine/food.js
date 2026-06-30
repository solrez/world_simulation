// ── Food, larder, and resource-patch primitives ──
// Low-level reads/writes on a person's larder, the shared village larder, and the
// world's renewable resource patches (berry/fishing/grove), pond level, and the
// communal field. Orchestration (daily regrowth, sharing, trade) stays in the
// tick; these are the shared primitives everything calls.

import {
  FOOD_TYPES, PATCH_MIN, PATCH_DEPLETE, PATCH_REGROW_PER_DAY,
  GROVE_DEPLETE, GROVE_REGROW_PER_DAY, POND_LEVEL_MAX, POND_LEVEL_MIN,
  POND_RAIN_GAIN, POND_EVAP, FARM,
} from '../utils/constants.js';
import { clamp } from './movement.js';

export function emptyLarder() { return { meat: 0, fish: 0, berries: 0, crops: 0 }; }

export function addFood(person, type, amount) {
  if (!person.larder) person.larder = emptyLarder();
  person.larder[type] = (person.larder[type] || 0) + amount;
}

export function totalFood(holder) {
  const l = holder.larder; if (!l) return 0;
  return (l.meat || 0) + (l.fish || 0) + (l.berries || 0) + (l.crops || 0);
}

// Eat the most-abundant food on hand; returns the hunger restored, or 0 if none.
// Eating a *different* type than last time gives a small variety mood bonus.
export function eatFood(person) {
  const l = person.larder; if (!l) return 0;
  let best = null, max = 0;
  for (const t of Object.keys(FOOD_TYPES)) if ((l[t] || 0) > max) { max = l[t]; best = t; }
  if (!best) return 0;
  l[best]--;
  const restore = FOOD_TYPES[best].hunger;
  person.hunger = clamp(person.hunger - restore, 0, 100);
  if (person.lastEaten && person.lastEaten !== best && person.mood === 'neutral') person.mood = 'content';
  person.lastEaten = best;
  return restore;
}

// Eat from the shared village larder (most abundant type). Returns hunger restored.
export function takeFromLarder(state, person) {
  const l = state.larder; if (!l) return 0;
  let best = null, max = 0;
  for (const t of Object.keys(FOOD_TYPES)) if ((l[t] || 0) > max) { max = l[t]; best = t; }
  if (!best) return 0;
  l[best]--;
  const restore = FOOD_TYPES[best].hunger * 0.85; // village fare slightly less filling
  person.hunger = clamp(person.hunger - restore, 0, 100);
  person.lastEaten = best;
  return restore;
}

// ── Resource patches (depletion + regrowth) ──
export function patchYield(state, name) {
  if (!state.patches) state.patches = {};
  const v = state.patches[name];
  return v == null ? 1 : v;
}

export function depletePatch(state, name) {
  if (!state.patches) state.patches = {};
  const cur = state.patches[name] == null ? 1 : state.patches[name];
  state.patches[name] = Math.max(PATCH_MIN, cur - PATCH_DEPLETE);
}

export function depleteGrove(state) {
  if (!state.patches) state.patches = {};
  const cur = state.patches['Grove'] == null ? 1 : state.patches['Grove'];
  state.patches['Grove'] = Math.max(PATCH_MIN, cur - GROVE_DEPLETE);
}

export function regrowPatches(state) {
  if (!state.patches) return;
  for (const k of Object.keys(state.patches)) {
    // the Grove recovers more slowly than berry/fishing patches — trees take time
    const rate = k === 'Grove' ? GROVE_REGROW_PER_DAY : PATCH_REGROW_PER_DAY;
    state.patches[k] = Math.min(1, state.patches[k] + rate);
  }
}

// Pond level rises with rain, evaporates in dry seasons — drives the visible water.
export function updatePond(state) {
  if (!state.pond) state.pond = { level: 1 };
  const rained = state.weather === 'rainy' || state.weather === 'storm';
  let lvl = state.pond.level + (rained ? POND_RAIN_GAIN : 0) - (POND_EVAP[state.season] || 0.02);
  state.pond.level = clamp(lvl, POND_LEVEL_MIN, POND_LEVEL_MAX);
}

// ── Farming: the communal field grows over days, only in growing seasons ──
// Sown crops creep forward on their own each day; tending (a work action) speeds
// it. Winter freezes progress so a field sown too late just sits — Q learns that.
export function growField(state) {
  const f = state.field;
  if (!f || !f.planted) return;
  if (!FARM.GROW_SEASONS.includes(state.season)) return; // frozen in winter
  f.stage = Math.min(FARM.RIPE, f.stage + FARM.PASSIVE_GROW_PER_DAY);
}

export function fieldReady(state) { return state.field?.planted && state.field.stage >= FARM.RIPE; }
