// ── Memory & emote leaf helpers ──
// Per-person episodic memory: recording, time-decay, and valence-weighted reads
// that bias where a person wants to go and how they feel about others. Plus the
// tiny emote setter. No cross-engine dependencies (constants only).

import {
  MEMORY_VALENCE, MEMORY_HALF_LIFE_GOOD, MEMORY_HALF_LIFE_BAD,
  MEMORY_MIN_WEIGHT, MEMORY_LOCATION_SENSITIVITY,
} from '../utils/constants.js';

export function addMemory(person, text, type, day, opts = {}) {
  const valence = opts.valence ?? MEMORY_VALENCE[type] ?? 0;
  const location = opts.location ?? null;
  person.memories.push({ text, type, day, valence, location, weight: Math.abs(valence) });
  if (person.memories.length > 30) person.memories.shift();
}

// Decay memory weights toward zero over days and prune faded ones. Cheap —
// called once per game-day, not per tick.
export function decayMemories(person, state) {
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
export function locationValence(person, locName) {
  if (!person.memories?.length) return 0;
  let sum = 0;
  for (const m of person.memories) {
    if (m.location === locName && m.valence) sum += m.weight * Math.sign(m.valence);
  }
  return sum;
}

// Signed feeling about another person, by name, from memories that mention them.
export function personValence(person, otherName) {
  if (!person.memories?.length || !otherName) return 0;
  // Match the name as a whole word so e.g. "Mara" doesn't match "Marabel".
  const nameRe = new RegExp(`\\b${otherName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  let sum = 0;
  for (const m of person.memories) {
    if (m.valence && m.text && nameRe.test(m.text)) sum += m.weight * Math.sign(m.valence);
  }
  return sum;
}

// Softmax over candidate location names weighted by the person's feelings about
// each. A strong aversion sharply downweights but never hard-bans a place;
// a fond memory upweights it. With no memories this is a uniform random pick.
export function weightedLocationPick(person, names) {
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

export function setEmote(person, emote, duration) {
  person.emote = emote;
  person.emoteTimer = duration || 25;
}
