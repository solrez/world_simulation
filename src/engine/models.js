// ── Per-agent model router & chronotype ──
// Each agent "thinks" with a specific LLM (distinct model = distinct voice).
// These helpers assign models weighted by recent reliability and bleed flaky
// models out of rotation over time. Plus the trait→chronotype mapping that
// shifts each agent's daily clock.

import { CHRONOTYPE_TRAITS, MODEL_POOL, MODEL_SMOOTHING, MODEL_WEIGHT_FLOOR } from '../utils/constants.js';

// A person's chronotype from their traits — first matching group wins. Drives a
// per-person shift of the daily schedule so the village isn't all on one clock.
export function chronotypeFor(traits = []) {
  if (traits.some(t => CHRONOTYPE_TRAITS.night.includes(t))) return 'night';
  if (traits.some(t => CHRONOTYPE_TRAITS.early.includes(t))) return 'early';
  return 'normal';
}

// Record whether a model returned usable output, for the assignment router (#8).
export function recordModelResult(state, model, ok) {
  if (!model || !state) return;
  if (!state.modelStats) state.modelStats = {};
  const s = state.modelStats[model] || (state.modelStats[model] = { calls: 0, ok: 0, fail: 0 });
  s.calls++;
  if (ok) s.ok++; else s.fail++;
}

// Once a day, move agents off a model that's proven unreliable to a weighted
// pick from the pool — voices stay mostly stable, but a flaky model bleeds out
// of rotation over time. Only acts on models with enough samples to judge.
export function reassignFlakyModels(state) {
  const ms = state.modelStats;
  if (!ms) return;
  for (const p of state.people) {
    if (p.alive === false) continue;
    const s = ms[p.model];
    if (!s || s.calls < 6) continue;
    const rate = s.ok / s.calls;
    if (rate < 0.5 && Math.random() < (0.5 - rate)) {
      const next = pickModelWeighted(ms);
      if (next && next !== p.model) p.model = next;
    }
  }
}

// Pick a model from the pool weighted by recent reliability (Laplace-smoothed
// success rate), so flaky models get assigned less without ever being banned.
// Falls back to uniform random when no stats exist yet.
export function pickModelWeighted(modelStats) {
  if (!modelStats) return MODEL_POOL[Math.floor(Math.random() * MODEL_POOL.length)];
  const weights = MODEL_POOL.map(m => {
    const s = modelStats[m];
    const ok = (s?.ok || 0) + MODEL_SMOOTHING;
    const total = (s?.ok || 0) + (s?.fail || 0) + 2 * MODEL_SMOOTHING;
    return Math.max(MODEL_WEIGHT_FLOOR, ok / total);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < MODEL_POOL.length; i++) { r -= weights[i]; if (r <= 0) return MODEL_POOL[i]; }
  return MODEL_POOL[MODEL_POOL.length - 1];
}
