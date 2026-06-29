// ── Lightweight goal completion ──
//
// Most goals in the sim only clear when their `until` tick-budget runs out (see
// the countdown in simulateTick). That makes villagers linger on a finished task
// — standing on a build site that's done, or holding wood but still "chopping" —
// until the timer happens to lapse. This module adds early, intent-based
// completion: a small set of cheap checks that recognize "this goal is actually
// accomplished" and clear `currentGoal` now, so the gate re-decides next tick.
//
// Deliberately conservative: it only clears on a CLEAR completion signal. Goals
// it doesn't understand are left alone and still expire via `until` as before.
// Kept in its own file to avoid growing simulation.js further.

// material goals → the inventory key they're working toward, and how much is "enough"
const MATERIAL_GOALS = {
  chop_wood:     { key: 'wood',   enough: 3 },
  collect_stone: { key: 'stone',  enough: 2 },
  gather_thatch: { key: 'thatch', enough: 2 },
};

// goals considered "done on arrival" — once they have no walk target left, the
// trip is over and there's nothing further the goal itself drives.
const ARRIVAL_GOALS = new Set(['go_to', 'seek', 'social', 'shelter', 'play']);

// Has the person arrived (no active walk destination)?
function arrived(person) {
  return person.targetX == null && person.targetY == null;
}

// Returns true if `person.currentGoal` is complete and should be cleared now.
// Pure inspection — does not mutate. `state` is the live sim state.
export function isGoalComplete(person, state) {
  const goal = person.currentGoal;
  if (!goal) return false;

  // sleep/eat are completion-managed by updateNeeds (wake when rested / done when
  // full); never short-circuit them here.
  if (goal.type === 'sleep' || goal.type === 'eat') return false;

  // building: done the moment the project is finished or gone.
  if (goal.type === 'build') {
    return !person.buildProject || person.buildProject.phase === 'complete';
  }

  // gathering a build material: done once they hold enough of it.
  const mat = MATERIAL_GOALS[goal.type];
  if (mat) {
    return (person.inventory?.[mat.key] || 0) >= mat.enough;
  }

  // seek_material: the goal's target names the material wanted.
  if (goal.type === 'seek_material' && goal.target) {
    return (person.inventory?.[goal.target] || 0) >= 2;
  }

  // farming: done when there's no ripe field left to work AND they've arrived
  // (so they don't abandon the walk over before reaching the field).
  if (goal.type === 'farm') {
    const fieldRipe = state.field?.planted && state.field.stage >= 1;
    return arrived(person) && !fieldRipe;
  }

  // pure travel/social goals: complete once they've reached the destination.
  if (ARRIVAL_GOALS.has(goal.type)) {
    return arrived(person);
  }

  // everything else (work, craft, heal, prototype, wander, …) keeps its timer.
  return false;
}

// Clear the goal if complete. Returns true if it cleared one. Mutating wrapper
// so simulation.js can call this once per person per tick.
export function clearCompletedGoal(person, state) {
  if (person.currentGoal && isGoalComplete(person, state)) {
    person.currentGoal = null;
    if (person.idle != null) person.idle = 0; // let the schedule pick something fresh
    return true;
  }
  return false;
}
