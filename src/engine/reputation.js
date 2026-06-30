// ── Reputation & gossip ──
// The village's collective standing for each person across several dimensions,
// plus how gossip propagates private beliefs about absent third parties. A blank
// record sits at neutral; standing decays toward neutral so it must be re-earned.

import { REPUTATION_DIMS, REPUTATION_DECAY_PER_DAY, GOSSIP_PULL } from '../utils/constants.js';
import { clamp } from './movement.js';

// A blank reputation record (all dimensions neutral at 0).
export function blankReputation() {
  const r = {};
  for (const d of REPUTATION_DIMS) r[d] = 0;
  return r;
}

// Nudge the village's collective read on `name` along one dimension, and slowly
// decay everyone's standing toward neutral so reputations must be re-earned.
export function bumpReputation(state, name, dim, delta) {
  if (!state.reputation) state.reputation = {};
  const r = state.reputation[name] || (state.reputation[name] = blankReputation());
  if (r[dim] == null) r[dim] = 0;
  r[dim] = clamp(r[dim] + delta, -100, 100);
}

export function decayReputation(state) {
  if (!state.reputation) return;
  for (const rec of Object.values(state.reputation))
    for (const d of REPUTATION_DIMS) rec[d] = (rec[d] || 0) * REPUTATION_DECAY_PER_DAY;
}

// Choose a juicy absent third party to gossip about: someone the speaker has a
// relationship with who ISN'T in the current conversation. Prefers people the
// speaker feels strongly about (high or low affection) — those make better talk.
export function pickGossipTarget(speaker, present, allPeople) {
  const presentNames = new Set([speaker.name, ...present.map(p => p.name)]);
  const candidates = allPeople.filter(p => p.alive !== false && !presentNames.has(p.name) && speaker.relationships?.[p.name]?.familiarity > 10);
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const ra = speaker.relationships[a.name], rb = speaker.relationships[b.name];
    return Math.abs((rb.affection ?? 50) - 50) - Math.abs((ra.affection ?? 50) - 50);
  });
  // mostly the most-salient, sometimes a random other for variety
  return Math.random() < 0.7 ? candidates[0] : candidates[Math.floor(Math.random() * candidates.length)];
}

// A listener hearing gossip nudges their private belief about the absent person
// toward the speaker's lean — this is how reputation travels third-hand.
export function applyGossip(speaker, listeners, absentName, sign, state) {
  if (!sign) return;
  const villageRep = (state.reputation || {})[absentName] || blankReputation();
  for (const listener of listeners) {
    if (!listener.reputationBeliefs) listener.reputationBeliefs = {};
    const belief = listener.reputationBeliefs[absentName] || (listener.reputationBeliefs[absentName] = { ...villageRep });
    // pull the belief toward a generally-good or generally-bad read
    for (const d of REPUTATION_DIMS) {
      const target = sign * 30;
      belief[d] = clamp((belief[d] || 0) + (target - (belief[d] || 0)) * GOSSIP_PULL, -100, 100);
    }
    // trusting the speaker, the listener's own affection drifts slightly too
    const lr = listener.relationships?.[absentName];
    if (lr) lr.affection = clamp(lr.affection + sign * 1.5, 0, 100);
  }
}

// The single word the village most associates with someone (for prompts), or null.
export function reputationLabel(state, name) {
  const r = state.reputation?.[name];
  if (!r) return null;
  let best = null, mag = 12; // needs a real reputation to surface
  for (const d of REPUTATION_DIMS) {
    if (Math.abs(r[d]) > mag) { mag = Math.abs(r[d]); best = { dim: d, val: r[d] }; }
  }
  if (!best) return null;
  const POS = { generous: 'generous', kind: 'kind', skilled: 'highly skilled', reliable: 'dependable', brave: 'brave' };
  const NEG = { generous: 'selfish', kind: 'cold', skilled: 'unskilled', reliable: 'unreliable', brave: 'timid' };
  return best.val > 0 ? POS[best.dim] : NEG[best.dim];
}
