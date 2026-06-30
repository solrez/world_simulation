// ── Tech metrics (Phase 4) ──
//
// A compact, always-on tally of how the discovery system is actually behaving —
// the "is it working at the right RATES" view, distinct from the per-event debug
// log. Lives on state.techMetrics; the panel reads it, and it's cheap to update.
//
// Counters answer the proposal's day-1 questions:
//   experiments / success rate  -> attempts, successes, failures
//   gate health                 -> gateRejects (by reason)
//   new materials discovered     -> materialsDiscovered, recipesMinted
//   recipe survival              -> firstSeenDay per recipe (age = today - firstSeen)
//   impact                       -> read live from larder/farmYield elsewhere

export function blankTechMetrics() {
  return {
    attempts: 0,          // total prototype attempts resolved
    successes: 0,         // breakthroughs
    failures: 0,          // failed attempts
    recipesMinted: 0,     // novel recipes authored by discovery (not built-ins)
    materialsDiscovered: 0,
    gatePasses: 0,
    gateRejects: 0,
    rejectReasons: {},    // { reason -> count } — what's blocking ideas
    firstSeenDay: {},     // { recipeId -> day first prototyped } for survival/age
    byProcess: {},        // { process -> { minted, success } } — which verbs pay off
  };
}

const m = (state) => (state.techMetrics ||= blankTechMetrics());

export function recordAttempt(state, succeeded) {
  const t = m(state);
  t.attempts++;
  if (succeeded) t.successes++; else t.failures++;
}

export function recordGate(state, ok, reason) {
  const t = m(state);
  if (ok) { t.gatePasses++; return; }
  t.gateRejects++;
  const r = reason || 'unknown';
  t.rejectReasons[r] = (t.rejectReasons[r] || 0) + 1;
}

export function recordMint(state, recipe, process, day) {
  const t = m(state);
  t.recipesMinted++;
  t.materialsDiscovered++; // a mint registers (at most) one new material
  if (recipe?.id && t.firstSeenDay[recipe.id] == null) t.firstSeenDay[recipe.id] = day;
  if (process) {
    const p = (t.byProcess[process] ||= { minted: 0, success: 0 });
    p.minted++;
  }
}

export function recordBreakthroughMetric(state, recipe, process) {
  const t = m(state);
  if (process) {
    const p = (t.byProcess[process] ||= { minted: 0, success: 0 });
    p.success++;
  }
}

// A derived snapshot for the UI / a metrics log line. Pure read.
export function summarizeTech(state) {
  const t = state.techMetrics || blankTechMetrics();
  const successRate = t.attempts ? t.successes / t.attempts : 0;
  const topReject = Object.entries(t.rejectReasons).sort((a, b) => b[1] - a[1])[0];
  return {
    day: state.day,
    attempts: t.attempts,
    successRate: Math.round(successRate * 100) / 100,
    recipesMinted: t.recipesMinted,
    materialsDiscovered: t.materialsDiscovered,
    gatePasses: t.gatePasses,
    gateRejects: t.gateRejects,
    topReject: topReject ? `${topReject[0]} (${topReject[1]})` : null,
  };
}
