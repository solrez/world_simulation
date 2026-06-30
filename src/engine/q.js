// ── Q-learning-lite ──
// Agents learn which productive actions pay off, per coarse (season|need) context.
// The table stays tiny so it learns fast and stays inspectable. Also the small
// "who's the village's best X" helpers that ride alongside the learned values.

import { Q_ALPHA } from '../utils/constants.js';

// Coarse context keeps the table tiny so it learns fast and stays inspectable.
export function qContext(person, state) {
  const need = person.hunger > 60 ? 'hungry' : person.tiredness > 60 ? 'tired' : 'ok';
  return `${state.season}|${need}`;
}

// Incremental Q update: estimate moves ALPHA of the way toward observed reward.
export function rewardAction(person, action, reward, state) {
  if (!person.qValues) person.qValues = {};
  if (!person.actionStats) person.actionStats = {};
  const key = `${qContext(person, state)}:${action}`;
  const q = person.qValues[key] ?? 0;
  person.qValues[key] = q + Q_ALPHA * (reward - q);
  const s = person.actionStats[action] || { tries: 0, total: 0 };
  s.tries++; s.total += reward;
  person.actionStats[action] = s;
}

// The skill a person is best at — their emerging identity in the village.
export function topSkill(person) {
  let best = null, max = 8; // must be meaningfully skilled to "be" something
  for (const [k, v] of Object.entries(person.skills || {})) if (v > max) { max = v; best = k; }
  return best;
}

// The village's go-to person for a given skill (its best living practitioner
// above a competence floor), excluding `exclude`. Powers specialist-seeking (#5):
// the sick seek the best healer, the hungry the best provider, etc.
export function bestSpecialist(people, skill, exclude, floor = 20) {
  let best = null, max = floor;
  for (const p of people) {
    if (p.alive === false || p === exclude || p.name === exclude?.name) continue;
    const v = p.skills?.[skill] || 0;
    if (v > max) { max = v; best = p; }
  }
  return best;
}

// Learned value of one action in the current context (0 if untried).
export function qValue(person, state, action) {
  if (!person.qValues) return 0;
  return person.qValues[`${qContext(person, state)}:${action}`] ?? 0;
}

// Top actions by learned value in the current context (for prompts/fallback).
export function qBestActions(person, state, n = 3) {
  if (!person.qValues) return [];
  const ctx = qContext(person, state);
  const rows = Object.entries(person.qValues)
    .filter(([k]) => k.startsWith(ctx + ':'))
    .map(([k, v]) => ({ action: k.split(':')[1], value: v }))
    .sort((a, b) => b.value - a.value);
  return rows.slice(0, n);
}
