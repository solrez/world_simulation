// ── Local schedule & target picking ──
// The cheap, deterministic behaviour the agents run between LLM turns: which work
// action to take (ε-greedy over learned Q-values), and where to head based on
// their chronotype-shifted daily schedule (sleep/work/eat/social/free). Picks
// social, mood, and explore targets.

import { FARM, Q_EPSILON, LOCATIONS, MOOD_LOCATIONS, LIFE_STAGES, MAP_W, MAP_H } from '../utils/constants.js';
import { nearestVisiblePrey } from './vision.js';
import { personTimeOfDay, goToLocation, goToPerson, setGoal, clamp } from './movement.js';
import { weightedLocationPick } from './memory.js';
import { qValue } from './q.js';
import { beginSleep } from './needs.js';
import { SCHEDULE } from './person.js';

// Which productive action to do, ε-greedy over learned Q-values. This is the
// local adaptation between LLM calls: agents lean into what's worked, but still
// explore (Q_EPSILON) so they discover hunting/building pay off.
const WORK_ACTIONS = ['fish', 'forage', 'hunt', 'chop_wood', 'farm'];
function pickWorkAction(person, state) {
  // a ripe field is free food — go reap it; a fallow field in a growing season
  // is worth sowing so the crop cycle keeps going (otherwise it dies after one
  // harvest because nobody re-plants). Both bias toward farming, with some noise.
  const f = state.field;
  if (f) {
    if (f.planted && f.stage >= FARM.RIPE && Math.random() < 0.7) return 'farm';
    if (!f.planted && FARM.GROW_SEASONS.includes(state.season) && Math.random() < 0.3) return 'farm';
  }
  if (Math.random() < Q_EPSILON) return WORK_ACTIONS[Math.floor(Math.random() * WORK_ACTIONS.length)];
  let best = WORK_ACTIONS[0], bestV = -Infinity;
  for (const a of WORK_ACTIONS) {
    const v = qValue(person, state, a) + Math.random() * 0.01; // tiny tiebreak jitter
    if (v > bestV) { bestV = v; best = a; }
  }
  return best;
}
function startWorkAction(person, action, state) {
  const map = {
    fish: ['Fishing Spot', 'gathering'],
    forage: ['Berry Bush', 'gathering'],
    chop_wood: ['Grove', 'chopping'],
    farm: ['Field', 'farming'],
  };
  if (action === 'hunt') {
    // begin a hunt — processHunting takes over each tick, finding prey via sight
    // and chasing it. Don't lock a goal (that would freeze the pursuit).
    const tooHard = (person.skills?.hunting || 0) < 8;
    const prey = nearestVisiblePrey(person, state, { allowDangerous: !tooHard })
      || (state.wildlife || []).find(w => w.alive); // none in sight → go look near one
    if (prey) {
      person.activity = 'hunting';
      person._huntTargetId = null; person._huntScan = 0;
      person.targetX = prey.x; person.targetY = prey.y;
      person.thought = 'Spotted something to hunt...';
      return;
    }
    action = 'forage'; // genuinely no animals anywhere → fall back
  }
  const [loc, act] = map[action] || map.forage;
  goToLocation(person, loc);
  person.activity = act;
  setGoal(person, 'work', loc, 40);
}

export function pickTarget(person, people, state) {
  // each agent runs on their own chronotype-shifted clock, so the village isn't
  // all asleep or all working at once.
  const schedule = SCHEDULE[personTimeOfDay(person, state)] || 'free';

  // daily routine drives behavior
  switch (schedule) {
    case 'sleep':
      // it's their bedtime. If they own a home and are at all tired, head there to
      // sleep (this is what makes a built house visibly used at night). The
      // walk-home-then-sleep is handled by beginSleep.
      if (person.home && person.tiredness > 15) { beginSleep(person, 500); return; }
      if (person.tiredness > 30) return; // otherwise let the reflex handle it
      // those still awake on their clock wander rather than freeze
      if (person.chronotype === 'night' || person.traits.includes('restless') || Math.random() < 0.2) {
        goToLocation(person, person.favoriteLocation || 'Campfire');
        setGoal(person, 'wander', null, 20);
      }
      return;

    case 'work':
      // pick the work that's been paying off (learned), with some exploration
      if (Math.random() < 0.6) {
        startWorkAction(person, pickWorkAction(person, state), state);
      } else {
        pickExploreTarget(person);
      }
      return;

    case 'eat':
      if (person.hunger > 30) {
        const foodLocs = ['Berry Bush', 'Fishing Spot'];
        goToLocation(person, foodLocs[Math.floor(Math.random() * foodLocs.length)]);
        person.activity = 'gathering';
        setGoal(person, 'eat', null, 30);
      } else {
        pickSocialTarget(person, people);
      }
      return;

    case 'social':
    case 'free':
      // mood-driven or social
      if (person.partner && Math.random() < 0.3) {
        const partner = people.find(p => p.name === person.partner);
        if (partner && !partner.sleeping) { goToPerson(person, partner); setGoal(person, 'seek', partner.name, 25); return; }
      }
      // homebodies (loners/elders) gravitate to their own spot — territoriality
      if (person.favoriteLocation && person.loneliness < 45) {
        const homey = person.traits.includes('evasive') || person.lifeStage === LIFE_STAGES.ELDER ? 0.5 : 0.25;
        if (Math.random() < homey) { goToLocation(person, person.favoriteLocation); setGoal(person, 'wander', null, 25); return; }
      }
      if (person.loneliness > 40 || Math.random() < 0.4) {
        pickSocialTarget(person, people);
      } else {
        pickMoodTarget(person);
      }
      return;
  }
}

function pickSocialTarget(person, people) {
  // go to where other people are, or campfire
  const others = people.filter(p => p.name !== person.name && !p.sleeping);
  if (others.length && Math.random() < 0.6) {
    const target = others[Math.floor(Math.random() * others.length)];
    goToPerson(person, target);
    person.activity = 'seeking';
    setGoal(person, 'seek', target.name, 25);
  } else {
    goToLocation(person, 'Campfire');
    setGoal(person, 'social', null, 20);
  }
}

function pickMoodTarget(person) {
  const moodLocs = MOOD_LOCATIONS[person.mood];
  if (moodLocs && Math.random() < 0.7) {
    const name = weightedLocationPick(person, moodLocs);
    goToLocation(person, name);
  } else {
    pickExploreTarget(person);
  }
  setGoal(person, 'wander', null, 25);
}

export function pickExploreTarget(person) {
  const locs = Object.values(LOCATIONS);
  const name = weightedLocationPick(person, locs.map(l => l.name));
  const loc = locs.find(l => l.name === name) || locs[Math.floor(Math.random() * locs.length)];
  person.targetX = loc.x + (Math.random() - 0.5) * 4;
  person.targetY = loc.y + (Math.random() - 0.5) * 4;
  person.targetX = clamp(person.targetX, 1, MAP_W - 2);
  person.targetY = clamp(person.targetY, 1, MAP_H - 2);
  person.activity = 'exploring';
  setGoal(person, 'wander', null, 30);
}
