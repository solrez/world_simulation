import { LOCATIONS } from '../utils/constants.js';
import { divineKill, resurrect, godStartBuild } from '../engine/simulation.js';

const POWERS = [
  { id: 'smite', icon: '⚡', label: 'Smite', desc: 'Strike someone down', needsTarget: true, targetType: 'person' },
  { id: 'resurrect', icon: '🌟', label: 'Resurrect', desc: 'Raise the dead back to life', needsTarget: true, targetType: 'dead' },
  { id: 'bless', icon: '✨', label: 'Bless', desc: 'Fill with joy and energy', needsTarget: true, targetType: 'person' },
  { id: 'whisper', icon: '💭', label: 'Whisper', desc: 'Plant a thought', needsTarget: true, targetType: 'person' },
  { id: 'matchmake', icon: '💘', label: 'Matchmake', desc: 'Force two to meet', needsTarget: true, targetType: 'pair' },
  { id: 'build', icon: '🏗', label: 'Build', desc: 'Inspire someone to start building now', needsTarget: true, targetType: 'person' },
  { id: 'storm', icon: '🌩', label: 'Storm', desc: 'Bring a terrible storm', needsTarget: false },
  { id: 'feast', icon: '🍖', label: 'Feast', desc: 'Gift abundant food', needsTarget: false },
  { id: 'plague', icon: '☠', label: 'Plague', desc: 'Spread sickness', needsTarget: false },
  { id: 'miracle', icon: '🌟', label: 'Miracle', desc: 'Heal all and inspire', needsTarget: false },
  { id: 'fertility', icon: '🌱', label: 'Fertility', desc: 'Bless the land', needsTarget: false },
  { id: 'earthquake', icon: '🌋', label: 'Quake', desc: 'Shake the earth', needsTarget: false },
];

export function GodPowers({ onUsePower, activePower, onSelectPower }) {
  return (
    <div className="god-powers">
      <div className="section-label">God Powers</div>
      <div className="god-grid">
        {POWERS.map(p => (
          <button
            key={p.id}
            className={`god-btn ${activePower === p.id ? 'active' : ''}`}
            onClick={() => {
              if (p.needsTarget) {
                onSelectPower(activePower === p.id ? null : p.id);
              } else {
                onUsePower(p.id, null);
              }
            }}
            title={p.desc}
          >
            <span className="god-icon">{p.icon}</span>
            <span className="god-label">{p.label}</span>
          </button>
        ))}
      </div>
      {activePower && (
        <div className="god-hint">
          Click a villager to use {POWERS.find(p => p.id === activePower)?.label}
          <span className="cancel-link" onClick={() => onSelectPower(null)}> (cancel)</span>
        </div>
      )}
    </div>
  );
}

// Record a divine memory that actually PERSISTS. The old code pushed raw objects
// with no valence/weight, so the decay system treated them as weightless and they
// were forgotten almost immediately (and spamming powers evicted real memories).
// This mirrors the engine's addMemory: real valence → real weight → proper decay,
// with the 30-memory cap enforced. `type` here is the memory's emotional category.
function godMem(person, text, valence, day) {
  person.memories.push({ text, type: valence < 0 ? 'death' : 'god', day, valence, weight: Math.abs(valence) });
  // keep the most salient memories if over the cap: drop the lowest-weight one,
  // never silently shedding a heavy memory (a death) just because it's old.
  if (person.memories.length > 30) {
    let lo = 0;
    for (let i = 1; i < person.memories.length; i++) {
      if ((person.memories[i].weight ?? 0) < (person.memories[lo].weight ?? 0)) lo = i;
    }
    person.memories.splice(lo, 1);
  }
}

export function applyGodPower(powerId, targetIdx, gameRef, opts = {}) {
  const state = gameRef.current;
  const people = state.people;

  // never target the god's own avatar with a person-power (smite/bless/whisper)
  if (typeof targetIdx === 'number' && people[targetIdx]?.isAvatar) return;

  switch (powerId) {
    case 'smite': {
      if (targetIdx === null) return;
      const target = people[targetIdx];
      if (!target || target.alive === false) return;
      // route through the real death pipeline so stats, grief, the death event,
      // and oral-tradition knowledge-loss all fire (the World panel reads these).
      divineKill(state, targetIdx, 'divine wrath');
      // a stronger, anchored memory of the WITNESSED smiting for everyone near
      for (const p of people) {
        if (p.name === target.name || !p.alive || p.isAvatar) continue;
        godMem(p, `Saw the gods strike ${target.name} dead with a bolt from the sky`, -3, state.day);
        p.emote = 'fear'; p.emoteTimer = 50;
      }
      state.events.push({ day: state.day, hour: state.hour, participants: [target.name], summary: `⚡ The gods struck down ${target.name}!`, type: 'god' });
      break;
    }

    case 'resurrect': {
      if (targetIdx === null) return;
      const target = people[targetIdx];
      if (!target || target.alive !== false) return; // only the dead can be raised
      resurrect(state, targetIdx); // handles revive + village awe + memories + event
      break;
    }

    case 'bless': {
      if (targetIdx === null) return;
      const target = people[targetIdx];
      target.mood = 'excited';
      target.hunger = 0;
      target.tiredness = 0;
      target.loneliness = 0;
      target.emote = 'sparkle';
      target.emoteTimer = 60;
      godMem(target, 'Felt the warm touch of a divine blessing', 1.5, state.day);
      state.events.push({ day: state.day, hour: state.hour, participants: [target.name], summary: `✨ ${target.name} was blessed by the gods!`, type: 'god' });
      break;
    }

    case 'whisper': {
      if (targetIdx === null) return;
      const target = people[targetIdx];
      const custom = (opts.text || '').trim();
      if (custom) {
        // the god speaks directly into their mind — the words become their thought
        // and a lasting memory they may act on. This is the expressive whisper.
        target.thought = custom;
        target.emote = 'sparkle';
        target.emoteTimer = 24;
        godMem(target, `A divine whisper: "${custom.slice(0, 100)}"`, 1.5, state.day);
        // nudge them to reconsider what they're doing — they'll re-evaluate soon
        target.gateCooldown = 0;
        target.pendingLLM = true; // let their mind react to the whisper next turn
        // if the whisper names a villager, gently point them toward that person
        const named = people.find(p => p.alive !== false && p.name !== target.name && custom.includes(p.name));
        if (named) {
          target.targetX = named.x + (Math.random() - 0.5);
          target.targetY = named.y + (Math.random() - 0.5);
          target.currentGoal = { type: 'seek', target: named.name, until: 40 };
          target.activity = 'seeking';
        }
        state.events.push({ day: state.day, hour: state.hour, participants: [target.name], summary: `💭 The gods whispered to ${target.name}: "${custom.slice(0, 60)}${custom.length > 60 ? '…' : ''}"`, type: 'god' });
        break;
      }
      // ── fallback (no text given): the old behavior — urge them toward whoever
      // they're most drawn to ──
      let bestName = null, bestAttr = 0;
      for (const [name, rel] of Object.entries(target.relationships)) {
        if (rel.attraction > bestAttr && people.find(p => p.name === name)?.alive) {
          bestAttr = rel.attraction;
          bestName = name;
        }
      }
      if (bestName) {
        target.thought = `Something tells me I should talk to ${bestName}...`;
        const other = people.find(p => p.name === bestName);
        if (other) {
          target.targetX = other.x + (Math.random() - 0.5);
          target.targetY = other.y + (Math.random() - 0.5);
          target.currentGoal = { type: 'seek', target: bestName, until: 30 };
          target.activity = 'seeking';
        }
        target.emote = 'sparkle';
        target.emoteTimer = 20;
        godMem(target, `Heard a divine whisper urging me toward ${bestName}`, 1, state.day);
        state.events.push({ day: state.day, hour: state.hour, participants: [target.name], summary: `💭 The gods whispered to ${target.name}`, type: 'god' });
      }
      break;
    }

    case 'matchmake': {
      // fallback: random pair if no target
      const available = people.filter(p => (p.alive !== false) && !p.isAvatar && !p.partner);
      if (available.length < 2) return;
      const a = available[0], b = available[1];
      _applyMatchmake(a, b, state);
      break;
    }

    case 'matchmake_pair': {
      // targeted: targetIdx has { a, b } indices
      if (!targetIdx || targetIdx.a === undefined) return;
      const a = people[targetIdx.a], b = people[targetIdx.b];
      if (!a || !b || a.alive === false || b.alive === false) return;
      _applyMatchmake(a, b, state);
      break;
    }

    case 'build': {
      if (targetIdx === null) return;
      const target = people[targetIdx];
      if (!target || target.alive === false) return;
      if (target.buildProject) { target.thought = `I'm already building a ${target.buildProject.type}.`; break; }
      // start a project deterministically (no LLM), then nudge them to act on it
      godStartBuild(state, targetIdx);
      const bp = target.buildProject;
      if (bp) {
        // gift the full material cost so the player sees construction progress
        // immediately, instead of waiting out the gather-and-haul loop
        const mn = bp.materialsNeeded || {};
        target.inventory = target.inventory || {};
        target.inventory.wood = (target.inventory.wood || 0) + (mn.wood || 0);
        target.inventory.stone = (target.inventory.stone || 0) + (mn.stone || 0);
        target.inventory.thatch = (target.inventory.thatch || 0) + (mn.thatch || 0);
        // send them straight to the site and clear any competing goal
        target.targetX = bp.site.x;
        target.targetY = bp.site.y;
        target.currentGoal = { type: 'build', until: 120 };
        target.activity = 'building';
      }
      target.gateCooldown = 0;
      godMem(target, 'Felt a divine urge to build something', 1.5, state.day);
      break;
    }

    case 'storm': {
      state.weather = 'storm';
      for (const p of people) {
        if (p.alive === false || p.isAvatar) continue;
        p.mood = 'anxious';
        p.emote = 'fear';
        p.emoteTimer = 30;
        if (p.home) { p.targetX = p.home.x; p.targetY = p.home.y; }
        else { p.targetX = LOCATIONS.CAMPFIRE.x; p.targetY = LOCATIONS.CAMPFIRE.y; } // shelter at the fire
        p.currentGoal = { type: 'shelter', until: 40 };
      }
      state.events.push({ day: state.day, hour: state.hour, participants: [], summary: `🌩 A terrible storm was sent by the gods!`, type: 'god' });
      break;
    }

    case 'feast': {
      // satisfy everyone NOW *and* actually stock the shared larder so the relief
      // lasts (previously feast only zeroed the hunger stat — villagers got hungry
      // again with nothing to eat, so it felt like it did nothing).
      if (!state.larder) state.larder = { meat: 0, fish: 0, berries: 0, crops: 0 };
      const aliveCount = people.filter(p => p.alive !== false && !p.isAvatar).length || 1;
      state.larder.meat = (state.larder.meat || 0) + aliveCount * 4;
      state.larder.crops = (state.larder.crops || 0) + aliveCount * 4;
      state.larder.berries = (state.larder.berries || 0) + aliveCount * 3;
      state.larder.fish = (state.larder.fish || 0) + aliveCount * 3;
      for (const p of people) {
        if (p.alive === false || p.isAvatar) continue;
        p.hunger = 0;
        // also drop a couple of meals straight into their pack so the next pang
        // is covered even before they reach the larder
        if (p.larder) { p.larder.meat = (p.larder.meat || 0) + 2; p.larder.berries = (p.larder.berries || 0) + 2; }
        p.mood = 'happy';
        p.emote = 'eat';
        p.emoteTimer = 30;
        godMem(p, 'The gods blessed us with abundant food', 1.5, state.day);
      }
      state.events.push({ day: state.day, hour: state.hour, participants: [], summary: `🍖 The gods gifted a great feast!`, type: 'god' });
      break;
    }

    case 'plague': {
      for (const p of people) {
        if (p.alive === false || p.isAvatar) continue;
        p.hunger = Math.min(100, p.hunger + 40);
        p.tiredness = Math.min(100, p.tiredness + 30);
        p.mood = 'sad';
        p.emote = 'sick';
        p.emoteTimer = 50;
        godMem(p, 'A plague swept through the village', -1.5, state.day);
      }
      state.events.push({ day: state.day, hour: state.hour, participants: [], summary: `☠ A plague was unleashed upon the village!`, type: 'god' });
      break;
    }

    case 'miracle': {
      for (const p of people) {
        if (p.alive === false || p.isAvatar) continue;
        p.hunger = 0;
        p.tiredness = 0;
        p.loneliness = 0;
        p.mood = 'excited';
        p.emote = 'sparkle';
        p.emoteTimer = 50;
        godMem(p, 'A miracle healed and inspired the whole village', 2, state.day);
      }
      state.events.push({ day: state.day, hour: state.hour, participants: [], summary: `🌟 A divine miracle healed the village!`, type: 'god' });
      break;
    }

    case 'fertility': {
      // boost pregnancy chance for partnered couples
      for (const p of people) {
        if (p.alive === false || p.gender !== 'female' || !p.partner || p.pregnant) continue;
        p.pregnant = true;
        p.pregnancyTimer = 80;
        p.emote = 'sparkle';
        p.emoteTimer = 40;
        godMem(p, 'Blessed with fertility by the gods', 1.5, state.day);
        const partner = people.find(pp => pp.name === p.partner);
        if (partner) godMem(partner, `${p.name} was blessed with fertility`, 1.5, state.day);
      }
      state.events.push({ day: state.day, hour: state.hour, participants: [], summary: `🌱 The gods blessed the village with fertility!`, type: 'god' });
      break;
    }

    case 'earthquake': {
      // destroy a random building
      if (state.buildings.length > 0) {
        const idx = Math.floor(Math.random() * state.buildings.length);
        const destroyed = state.buildings.splice(idx, 1)[0];
        for (const p of people) {
          if (p.home === destroyed) p.home = null;
          if (p.alive === false || p.isAvatar) continue;
          p.mood = 'anxious';
          p.emote = 'fear';
          p.emoteTimer = 30;
          godMem(p, 'An earthquake shook the village', -1.5, state.day);
        }
      }
      for (const p of people) {
        if (p.alive === false || p.isAvatar) continue;
        p.mood = 'anxious';
      }
      state.events.push({ day: state.day, hour: state.hour, participants: [], summary: `🌋 An earthquake shook the village!`, type: 'god' });
      break;
    }
  }

  // every god power triggers awe
  const aweIntensity = {
    smite: 60, resurrect: 0, bless: 25, whisper: 10, matchmake: 15, matchmake_pair: 15, build: 10,
    storm: 50, feast: 35, plague: 55, miracle: 70, fertility: 30, earthquake: 65,
  };
  _spreadAwe(people, state, aweIntensity[powerId] || 20);
}

// After any god power, villagers sense a higher power
function _spreadAwe(people, state, intensity) {
  for (const p of people) {
    if (p.alive === false || p.isAvatar) continue;
    p.awe = Math.min(100, (p.awe || 0) + intensity);
    if (intensity > 30) {
      // don't flood: only record the awe memory if they don't already have a
      // fresh one from today (spamming powers used to bury real memories)
      const hasRecent = p.memories.some(m => m.day === state.day && m.text?.startsWith('Felt the presence'));
      if (!hasRecent) godMem(p, 'Felt the presence of something beyond this world', 1, state.day);
      p.mood = intensity > 50 ? 'anxious' : 'thoughtful';
    }
  }
  if (intensity > 20) {
    state.events.push({ day: state.day, hour: state.hour, participants: [], summary: `🌌 The villagers sense a divine presence watching over them.`, type: 'god' });
  }
}

function _applyMatchmake(a, b, state) {
  const relA = a.relationships[b.name];
  const relB = b.relationships[a.name];
  if (relA) { relA.attraction = Math.min(100, relA.attraction + 30); relA.affection = Math.min(100, relA.affection + 20); relA.familiarity = Math.min(100, relA.familiarity + 15); }
  if (relB) { relB.attraction = Math.min(100, relB.attraction + 30); relB.affection = Math.min(100, relB.affection + 20); relB.familiarity = Math.min(100, relB.familiarity + 15); }
  a.targetX = b.x; a.targetY = b.y;
  b.targetX = a.x; b.targetY = a.y;
  a.currentGoal = { type: 'seek', target: b.name, until: 30 };
  b.currentGoal = { type: 'seek', target: a.name, until: 30 };
  a.emote = 'heart'; a.emoteTimer = 40;
  b.emote = 'heart'; b.emoteTimer = 40;
  godMem(a, `Felt an irresistible pull toward ${b.name}`, 1.5, state.day);
  godMem(b, `Felt an irresistible pull toward ${a.name}`, 1.5, state.day);
  state.events.push({ day: state.day, hour: state.hour, participants: [a.name, b.name], summary: `💘 The gods drew ${a.name} and ${b.name} together!`, type: 'god' });
}
