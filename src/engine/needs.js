// ── Needs, the escalation gate, sleep, reflexes, sharing & trade ──
// Per-tick bodily needs (hunger/tiredness/loneliness/awe), the gate that decides
// who reflexes locally vs. escalates to an LLM turn, the single-answer survival
// reflexes themselves, sleep handling, passive food-sharing, and barter. A pure
// leaf among the behaviour clusters — it calls only shared modules, nothing calls
// back into it except the tick and (for beginSleep) the scheduler / AI action.

import { LIFE_STAGES, GATE, RELATIONSHIP_STAGES, FARM, IDEA, DISCOVERY, LOCATIONS } from '../utils/constants.js';
import { nearestVisiblePrey } from './vision.js';
import { clamp, setGoal, goToLocation, distBetween } from './movement.js';
import { setEmote, addMemory, weightedLocationPick } from './memory.js';
import { eatFood, takeFromLarder, addFood, totalFood, fieldReady } from './food.js';
import { bumpReputation } from './reputation.js';
import { rewardAction, qValue } from './q.js';
import { pressingNeed } from './tech.js';

export function updateNeeds(person, timeOfDay, weather) {
  // hunger — very slow, ~8 game-hours to go from 0→70 (hungry)
  // 480 ticks (8 hrs) × rate ≈ 70. So rate ≈ 0.015 during day
  const hungerRate = timeOfDay === 'night' ? 0.008 : (weather === 'rainy' ? 0.012 : 0.015);
  person.hunger = clamp(person.hunger + hungerRate, 0, 100);

  // tiredness — awake ~16 hrs before exhausted
  if (person.sleeping) {
    // sleeping in your own home rests you faster (a real payoff for building)
    const atHome = person.home && Math.abs(person.x - person.home.x) < 2 && Math.abs(person.y - person.home.y) < 2;
    person.tiredness = clamp(person.tiredness - (atHome ? 0.3 : 0.2), 0, 100);
    if (person.tiredness <= 3) {
      person.sleeping = false;
      person.activity = 'wandering';
      person.currentGoal = null;
      setEmote(person, null, 0);
    }
  } else {
    const tiredRate = timeOfDay === 'night' ? 0.04 : (person.activity === 'working' ? 0.03 : 0.02);
    person.tiredness = clamp(person.tiredness + tiredRate, 0, 100);
  }

  // loneliness
  if (person.conversationId) {
    person.loneliness = clamp(person.loneliness - 0.3, 0, 100);
  } else {
    const rate = person.partner ? 0.015 : 0.025;
    person.loneliness = clamp(person.loneliness + rate, 0, 100);
  }

  // awe (sense of the divine) fades when the gods stay quiet — it's only renewed
  // by an actual god-power. So "something divine is watching" reflects RECENT
  // intervention, not a permanent religion the agents invent on their own.
  if (person.awe > 0) person.awe = Math.max(0, person.awe - 0.02);

  // eating — consumes from personal food or village food
  if (person.eating) {
    person.hunger = clamp(person.hunger - 0.8, 0, 100);
    if (person.hunger <= 5) {
      person.eating = false;
      person.activity = 'wandering';
      person.currentGoal = null;
    }
  }
}

// ── Escalation gate ──
//
// Per-person, per-tick verdict that decides who gets to "think":
//   REFLEX   — a one-answer survival situation; handle it locally, no LLM call.
//   ESCALATE — an interesting situation (conflict, competing desires, fresh
//              event, goal tension); mark pendingLLM so the LLM decides. The
//              LLM keeps ALL character/social/goal choices.
//   IDLE     — nothing urgent; the cheap local schedule wander handles it.
//
// This removes the old three-way race (needs + schedule + LLM all firing on the
// same tick) and stops spending LLM calls on reflexes that have one answer.
export function escalationGate(person, people, state) {
  if (person.lifeStage === LIFE_STAGES.BABY) return { verdict: 'IDLE' };
  // already acting on a reflex — let it run
  if (person.sleeping || person.eating) return { verdict: 'IDLE' };

  // ── reflexes: single-answer survival, handled locally ──
  // These are INSTINCTIVE and fire even mid-conversation: a starving or
  // exhausted person breaks off and tends to their body. runConversation checks
  // for this and bails the talker out, so nobody dies mid-sentence.
  if (person.tiredness > GATE.EXHAUSTED) return { verdict: 'REFLEX', reflex: 'sleep' };
  if (state.timeOfDay === 'night' && person.tiredness > GATE.NIGHT_TIRED && !person.targetX && !person.conversationId) {
    return { verdict: 'REFLEX', reflex: 'sleep' };
  }
  if (person.sick && person.tiredness > GATE.SICK_TIRED) return { verdict: 'REFLEX', reflex: 'sleep' };
  if (person.hunger > GATE.STARVING) return { verdict: 'REFLEX', reflex: 'eat' };
  if (state.weather === 'storm' && !person.conversationId) return { verdict: 'REFLEX', reflex: 'shelter' };

  // beyond survival reflexes, a conversation suppresses escalation/social logic
  // (the LLM is already driving the talk) and any in-progress goal owns the tick
  if (person.conversationId) return { verdict: 'IDLE' };
  if (person.currentGoal && person.currentGoal.until > 0) return { verdict: 'IDLE' };

  // ── escalation triggers (skip while on cooldown) ──
  if (person.gateCooldown <= 0) {
    // 1. fresh high-salience event since we last looked
    const lastMem = person.memories?.[person.memories.length - 1];
    if (lastMem && person.memories.length > person.eventSeen &&
        ['danger', 'death', 'conflict', 'kindness'].includes(lastMem.type)) {
      person.eventSeen = person.memories.length;
      return { verdict: 'ESCALATE' };
    }

    // 2. live relationship conflict with someone nearby
    for (const other of people) {
      if (other.name === person.name || other.alive === false) continue;
      if (distBetween(person, other) > 5) continue;
      const rel = person.relationships[other.name];
      if (!rel) continue;
      if (rel.jealousy > GATE.JEALOUSY_LIVE ||
          rel.stage === RELATIONSHIP_STAGES.RIVAL || rel.stage === RELATIONSHIP_STAGES.ENEMY) {
        return { verdict: 'ESCALATE' };
      }
    }

    // 3. competing desires — two mid-band needs at once, no single reflex answers
    const hungerMid = person.hunger >= GATE.HUNGER_BAND[0] && person.hunger <= GATE.HUNGER_BAND[1];
    const tiredMid = person.tiredness >= GATE.TIRED_BAND[0] && person.tiredness <= GATE.TIRED_BAND[1];
    const lonely = person.loneliness > GATE.LONELY_MID;
    const buildingNeedsWork = person.buildProject && person.buildProject.phase !== 'complete';
    if ((hungerMid && lonely) || (tiredMid && lonely) || (tiredMid && buildingNeedsWork)) {
      return { verdict: 'ESCALATE' };
    }

    // 4. the village is running out of food — a real "do I go help?" choice
    if (totalFood(state) < 20 && totalFood(person) < 5 && Math.random() < 0.1) {
      return { verdict: 'ESCALATE' };
    }

    // 5. a homeless adult wanting shelter — a real survival/comfort choice in ANY
    //    season (everyone wants a home; fall/winter just makes it urgent). Higher
    //    chance as cold approaches so houses actually get built before winter.
    if (!person.home && person.lifeStage === LIFE_STAGES.ADULT && !person.buildProject) {
      const urgency = (state.season === 'fall' || state.season === 'winter') ? 0.12 : 0.06;
      if (Math.random() < urgency) return { verdict: 'ESCALATE' };
    }

    // 6. hungry and hunting has paid off lately → consider a hunt
    if (person.hunger >= GATE.HUNGER_BAND[0] && qValue(person, state, 'hunt') > qValue(person, state, 'forage') &&
        Math.random() < 0.1) {
      return { verdict: 'ESCALATE' };
    }

    // 7. the field is ripe (food just sitting there) or fallow in a growing
    //    season — either is a real "should I go work the field?" decision.
    if (fieldReady(state) && Math.random() < 0.12) {
      return { verdict: 'ESCALATE' };
    }
    if (state.field && !state.field.planted && FARM.GROW_SEASONS.includes(state.season) &&
        totalFood(state) < 25 && Math.random() < 0.04) {
      return { verdict: 'ESCALATE' };
    }

    // 8. IDEATION (Phase 3) — a frustrated, inventive mind who's noticed raw
    //    materials gets the urge to TRY something. Routed to a separate
    //    constrained LLM call (pendingIdea), not the normal action prompt, so we
    //    flag it and let the tick continue with local behavior this turn.
    if (person.ideaCooldown <= 0 && !person.prototype &&
        Object.keys(person.noticedResources || {}).length > 0 &&
        (person.traits?.includes('curious') || person.traits?.includes('creative') || person.traits?.includes('handy')) &&
        pressingNeed(person, state) && Math.random() < IDEA.BASE_CHANCE * (DISCOVERY.RATE_MULT || 1)) {
      person.pendingIdea = true;
    }
  }

  return { verdict: 'IDLE' };
}

// Begin sleeping. If the person has a home they aren't already at, walk there
// FIRST (heading-home state) and only drop into actual sleep on arrival — this is
// what makes a built house get used. Without a home (or already home) they sleep
// in place immediately, as before. The `_sleepWhenHome` flag is consumed by the
// movement block in the main tick when they reach the house.
export function beginSleep(person, duration) {
  setGoal(person, 'sleep', null, duration);
  // Only sleep in place when essentially ON the house (within ~0.7 tile). Anything
  // further and they walk all the way home first, so they visibly sleep AT the
  // building rather than a tile or two beside it.
  const nearHome = person.home &&
    Math.abs(person.x - person.home.x) < 0.7 && Math.abs(person.y - person.home.y) < 0.7;
  if (person.home && !nearHome) {
    // head home, awake, then sleep once we arrive
    person._sleepWhenHome = true;
    person.targetX = person.home.x; person.targetY = person.home.y;
    person.activity = 'heading home';
    setEmote(person, 'zzz', 999);
    person.thought = 'Tired — heading home to rest.';
  } else {
    sleepNow(person);
  }
}

// Drop into actual sleep wherever the person currently stands.
export function sleepNow(person) {
  // snap exactly onto the home so the sleeper visibly rests inside the building,
  // not a fraction of a tile off-center.
  if (person.home && Math.abs(person.x - person.home.x) < 2 && Math.abs(person.y - person.home.y) < 2) {
    person.x = person.home.x; person.y = person.home.y;
  }
  person.sleeping = true;
  person.activity = 'sleeping';
  person._sleepWhenHome = false;
  person.targetX = null; person.targetY = null;
  person.path = null; person._pathDest = null;
  setEmote(person, 'zzz', 999);
}

// When two villagers pair up, a homeless partner moves into the other's home (and
// joins its owners). If both already have homes, they keep their own — no merge.
export function shareHomeWithPartner(a, b) {
  const home = a.home || b.home;
  if (!home) return;
  for (const p of [a, b]) {
    if (!p.home) {
      p.home = home;
      if (home.owners && !home.owners.includes(p.name)) home.owners.push(p.name);
    }
  }
}

// Apply a single-answer reflex locally — no LLM, no discretion.
export function applyReflex(person, reflex, state) {
  // survival reflexes are instinctive and break off a conversation: you can't
  // keep chatting when your body is screaming to eat or sleep. The conversation
  // loop sees the cleared conversationId next line and drops this speaker.
  if ((reflex === 'eat' || reflex === 'sleep') && person.conversationId) {
    person._leftConversation = person.conversationId;
    person.conversationId = null;
    person.conversationCooldown = 6 + Math.floor(Math.random() * 6);
  }
  switch (reflex) {
    case 'sleep': {
      beginSleep(person, person.sick ? 200 : 500);
      break;
    }
    case 'eat': {
      const relief = eatFood(person) || takeFromLarder(state, person);
      if (relief > 0) {
        person.eating = true; person.activity = 'eating';
        setEmote(person, 'eat', 30); setGoal(person, 'eat', null, 30);
        rewardAction(person, 'forage', relief / 20, state); // satisfying a need pays off
        break;
      }
      // Nothing on hand or in the larder — go GET food by whatever means. This is
      // instinctive, so we pick the best available producer, not just berries:
      //   1. a ripe field right there → harvest it (free, big yield)
      //   2. hunting if it's paid off lately and there's prey → meat
      //   3. otherwise the nearest food patch (berries / fish), memory-weighted
      if (fieldReady(state)) {
        goToLocation(person, 'Field'); person.activity = 'farming'; setGoal(person, 'farm', 'Field', 120);
        person.thought = 'Starving — the field is ripe, time to harvest.';
        break;
      }
      // hunt only what you can actually SEE — a hungry forager won't magically
      // know where distant game is. processHunting then runs the chase.
      const tooHard = (person.skills?.hunting || 0) < 8;
      const prey = nearestVisiblePrey(person, state, { allowDangerous: !tooHard });
      const huntPays = qValue(person, state, 'hunt') >= qValue(person, state, 'forage');
      if (prey && (huntPays || (person.skills?.hunting || 0) > 5)) {
        person.activity = 'hunting';
        person._huntTargetId = prey.id; person._huntScan = 0;
        person.targetX = prey.x; person.targetY = prey.y;
        person.thought = `Hungry — going after that ${prey.type}.`;
        break;
      }
      const foodLocs = Object.values(LOCATIONS).filter(l => l.type === 'food');
      const loc = weightedLocationPick(person, foodLocs.map(l => l.name));
      if (loc) { goToLocation(person, loc); person.activity = 'gathering'; setGoal(person, 'work', loc, 100); }
      break;
    }
    case 'shelter': {
      if (person.home) { person.targetX = person.home.x; person.targetY = person.home.y; }
      else goToLocation(person, 'Campfire');
      setGoal(person, 'shelter', null, 80);
      break;
    }
  }
}

// Passive generosity: sharing food with a hungry loved one nearby isn't really
// a "decision" — it's an automatic kind act. Runs every tick regardless of the
// gate, preserving the kindness-memory / affection mechanic.
export function processFoodSharing(person, people, state) {
  if (person.sleeping || person.eating || totalFood(person) <= 3) return;
  for (const other of people) {
    if (other.name === person.name || other.alive === false || other.hunger < 50) continue;
    if (distBetween(person, other) > 4) continue;
    const rel = person.relationships[other.name];
    if (!rel) continue;
    if (person.partner === other.name || rel.affection > 55 || rel.attraction > 60) {
      // give two units of whatever the giver has most of
      const give = ['meat', 'fish', 'crops', 'berries'].find(t => (person.larder?.[t] || 0) > 0);
      if (!give) break;
      person.larder[give] = Math.max(0, person.larder[give] - 2);
      addFood(other, give, 2);
      other.hunger = clamp(other.hunger - 15, 0, 100);
      setEmote(person, 'heart', 15);
      rel.affection = clamp(rel.affection + 2, 0, 100);
      const otherRel = other.relationships[person.name];
      if (otherRel) otherRel.affection = clamp(otherRel.affection + 3, 0, 100);
      addMemory(other, `${person.name} shared food with me`, 'kindness', state.day, { location: other.currentLocation });
      person.thought = `I gave food to ${other.name}`;
      // a visible kindness — earns a name for generosity (#2)
      bumpReputation(state, person.name, 'generous', 3);
      bumpReputation(state, person.name, 'kind', 1.5);
      break;
    } else if ((other.hunger > 75 && totalFood(person) > 6) && Math.random() < 0.02) {
      // hoarding while a hungry villager stands right there — a name for selfishness
      bumpReputation(state, person.name, 'generous', -2);
      if (other.relationships[person.name]) other.relationships[person.name].affection = clamp(other.relationships[person.name].affection - 1, 0, 100);
      addMemory(other, `${person.name} wouldn't share food while I was starving`, 'conflict', state.day, { location: other.currentLocation });
    }
  }
}

// Phase 7 — barter. When two villagers who aren't close enough to just GIVE meet
// and each holds a surplus the other lacks, they trade ("a copper knife for
// three fish"). This is the seed of an economy: goods move toward who needs them,
// and the exchange builds a little trust. Throttled so it's occasional, not spammy.
const TRADE_GOODS = ['meat', 'fish', 'crops', 'berries', 'copper_ingot', 'flint', 'clay', 'wood', 'stone'];
function holding(p, g) { return (p.larder?.[g] || 0) + (p.inventory?.[g] || 0); }
function moveGood(p, g, n) {
  // prefer pulling from larder for food, inventory for materials
  if ((p.larder?.[g] || 0) >= n) { p.larder[g] -= n; return; }
  if (p.inventory) p.inventory[g] = Math.max(0, (p.inventory[g] || 0) - n);
}
function giveGood(p, g, n) {
  if (['meat', 'fish', 'crops', 'berries'].includes(g)) addFood(p, g, n);
  else if (p.inventory) p.inventory[g] = (p.inventory[g] || 0) + n;
}
export function processTrade(person, people, state) {
  if (person.sleeping || person.eating || person.conversationId || Math.random() > 0.01) return;
  for (const other of people) {
    if (other.name === person.name || other.alive === false || other.sleeping) continue;
    if (distBetween(person, other) > 3) continue;
    // what does each have plenty of that the other is short on?
    const mySurplus = TRADE_GOODS.find(g => holding(person, g) >= 4 && holding(other, g) <= 1);
    const theirSurplus = TRADE_GOODS.find(g => g !== mySurplus && holding(other, g) >= 4 && holding(person, g) <= 1);
    if (!mySurplus || !theirSurplus) continue;
    // a simple 2-for-3 style swap
    moveGood(person, mySurplus, 2); giveGood(other, mySurplus, 2);
    moveGood(other, theirSurplus, 3); giveGood(person, theirSurplus, 3);
    const rel = person.relationships[other.name];
    if (rel) rel.trust = clamp(rel.trust + 1.5, 0, 100);
    const orel = other.relationships[person.name];
    if (orel) orel.trust = clamp(orel.trust + 1.5, 0, 100);
    setEmote(person, 'sparkle', 8);
    person.thought = `Traded ${mySurplus} with ${other.name} for some ${theirSurplus}.`;
    addMemory(person, `Traded ${mySurplus} to ${other.name} for ${theirSurplus}.`, 'agreement', state.day, { location: person.currentLocation, valence: 0.5 });
    addMemory(other, `${person.name} traded me ${mySurplus} for ${theirSurplus}.`, 'agreement', state.day, { location: other.currentLocation, valence: 0.5 });
    state.events.push({ day: state.day, hour: state.hour, participants: [person.name, other.name],
      summary: `🤝 ${person.name} and ${other.name} traded ${mySurplus} for ${theirSurplus}.`, type: 'trade' });
    return;
  }
}

export function updateMoodFromNeeds(person) {
  if (person.sleeping) return;
  if (person.hunger > 75) { person.mood = 'annoyed'; return; }
  if (person.tiredness > 70) { person.mood = 'anxious'; return; }
  if (person.loneliness > 70) { person.mood = 'lonely'; return; }
  if (person.partner && person.loneliness < 25) {
    if (person.mood === 'neutral') person.mood = 'loving';
  }
  if (person.hunger < 25 && person.tiredness < 35 && person.loneliness < 35) {
    if (person.mood === 'neutral' || person.mood === 'anxious') person.mood = 'content';
  }
}

export function updateJealousy(person, people) {
  if (!person.partner) return;
  const partner = people.find(p => p.name === person.partner);
  if (!partner || !partner.conversationId || person.conversationId) return;
  for (const [name, rel] of Object.entries(partner.relationships)) {
    if (name === person.name) continue;
    if (rel.attraction > 55 && rel.familiarity > 20) {
      const myRel = person.relationships[name];
      if (myRel) {
        myRel.jealousy = clamp((myRel.jealousy || 0) + 1, 0, 100);
        if (myRel.jealousy > 40) { setEmote(person, 'jealous', 20); person.mood = 'jealous'; }
      }
    }
  }
}
