import { useState } from 'react';

const POWERS = [
  { id: 'smite', icon: '⚡', label: 'Smite', desc: 'Strike someone down', needsTarget: true, targetType: 'person' },
  { id: 'bless', icon: '✨', label: 'Bless', desc: 'Fill with joy and energy', needsTarget: true, targetType: 'person' },
  { id: 'whisper', icon: '💭', label: 'Whisper', desc: 'Plant a thought', needsTarget: true, targetType: 'person' },
  { id: 'matchmake', icon: '💘', label: 'Matchmake', desc: 'Force two to meet', needsTarget: true, targetType: 'pair' },
  { id: 'storm', icon: '🌩', label: 'Storm', desc: 'Bring a terrible storm', needsTarget: false },
  { id: 'feast', icon: '🍖', label: 'Feast', desc: 'Gift abundant food', needsTarget: false },
  { id: 'plague', icon: '☠', label: 'Plague', desc: 'Spread sickness', needsTarget: false },
  { id: 'miracle', icon: '🌟', label: 'Miracle', desc: 'Heal all and inspire', needsTarget: false },
  { id: 'fertility', icon: '🌱', label: 'Fertility', desc: 'Bless the land', needsTarget: false },
  { id: 'earthquake', icon: '🌋', label: 'Quake', desc: 'Shake the earth', needsTarget: false },
];

export function GodPowers({ people, onUsePower, activePower, onSelectPower }) {
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

export function applyGodPower(powerId, targetIdx, gameRef) {
  const state = gameRef.current;
  const people = state.people;

  switch (powerId) {
    case 'smite': {
      if (targetIdx === null) return;
      const target = people[targetIdx];
      target.alive = false;
      target.sleeping = false;
      target.eating = false;
      target.conversationId = null;
      target.activity = 'dead';
      target.emote = null;
      // grief for others
      for (const p of people) {
        if (p.name === target.name || !p.alive) continue;
        const rel = p.relationships[target.name];
        if (rel && rel.affection > 40) {
          p.mood = 'sad';
          p.emote = 'tear';
          p.emoteTimer = 60;
          p.memories.push({ text: `${target.name} was struck down by the gods`, type: 'death', day: state.day });
        }
        if (p.partner === target.name) {
          p.partner = null;
          p.mood = 'heartbroken';
          p.emote = 'tear';
          p.emoteTimer = 100;
          p.memories.push({ text: `Lost my partner ${target.name} to divine wrath`, type: 'death', day: state.day });
        }
      }
      state.events.push({ day: state.day, hour: state.hour, participants: [target.name], summary: `⚡ The gods struck down ${target.name}!`, type: 'god' });
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
      target.memories.push({ text: 'Felt the warm touch of a divine blessing', type: 'god', day: state.day });
      state.events.push({ day: state.day, hour: state.hour, participants: [target.name], summary: `✨ ${target.name} was blessed by the gods!`, type: 'god' });
      break;
    }

    case 'whisper': {
      if (targetIdx === null) return;
      const target = people[targetIdx];
      // plant a thought that makes them seek the most attractive person
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
        target.memories.push({ text: `Heard a divine whisper urging me toward ${bestName}`, type: 'god', day: state.day });
        state.events.push({ day: state.day, hour: state.hour, participants: [target.name], summary: `💭 The gods whispered to ${target.name}`, type: 'god' });
      }
      break;
    }

    case 'matchmake': {
      // fallback: random pair if no target
      const available = people.filter(p => (p.alive !== false) && !p.partner);
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

    case 'storm': {
      state.weather = 'storm';
      for (const p of people) {
        if (p.alive === false) continue;
        p.mood = 'anxious';
        p.emote = 'fear';
        p.emoteTimer = 30;
        if (p.home) { p.targetX = p.home.x; p.targetY = p.home.y; }
        else { p.targetX = 14; p.targetY = 10; } // campfire
        p.currentGoal = { type: 'shelter', until: 40 };
      }
      state.events.push({ day: state.day, hour: state.hour, participants: [], summary: `🌩 A terrible storm was sent by the gods!`, type: 'god' });
      break;
    }

    case 'feast': {
      for (const p of people) {
        if (p.alive === false) continue;
        p.hunger = 0;
        p.mood = 'happy';
        p.emote = 'eat';
        p.emoteTimer = 30;
        p.memories.push({ text: 'The gods blessed us with abundant food', type: 'god', day: state.day });
      }
      state.events.push({ day: state.day, hour: state.hour, participants: [], summary: `🍖 The gods gifted a great feast!`, type: 'god' });
      break;
    }

    case 'plague': {
      for (const p of people) {
        if (p.alive === false) continue;
        p.hunger = Math.min(100, p.hunger + 40);
        p.tiredness = Math.min(100, p.tiredness + 30);
        p.mood = 'sad';
        p.emote = 'sick';
        p.emoteTimer = 50;
        p.memories.push({ text: 'A plague swept through the village', type: 'god', day: state.day });
      }
      state.events.push({ day: state.day, hour: state.hour, participants: [], summary: `☠ A plague was unleashed upon the village!`, type: 'god' });
      break;
    }

    case 'miracle': {
      for (const p of people) {
        if (p.alive === false) continue;
        p.hunger = 0;
        p.tiredness = 0;
        p.loneliness = 0;
        p.mood = 'excited';
        p.emote = 'sparkle';
        p.emoteTimer = 50;
        p.memories.push({ text: 'A miracle healed and inspired the whole village', type: 'god', day: state.day });
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
        p.memories.push({ text: 'Blessed with fertility by the gods', type: 'god', day: state.day });
        const partner = people.find(pp => pp.name === p.partner);
        if (partner) partner.memories.push({ text: `${p.name} was blessed with fertility`, type: 'god', day: state.day });
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
          if (p.alive === false) continue;
          p.mood = 'anxious';
          p.emote = 'fear';
          p.emoteTimer = 30;
          p.memories.push({ text: 'An earthquake shook the village', type: 'god', day: state.day });
        }
      }
      for (const p of people) {
        if (p.alive === false) continue;
        p.mood = 'anxious';
      }
      state.events.push({ day: state.day, hour: state.hour, participants: [], summary: `🌋 An earthquake shook the village!`, type: 'god' });
      break;
    }
  }

  // every god power triggers awe
  const aweIntensity = {
    smite: 60, bless: 25, whisper: 10, matchmake: 15, matchmake_pair: 15,
    storm: 50, feast: 35, plague: 55, miracle: 70, fertility: 30, earthquake: 65,
  };
  _spreadAwe(people, state, aweIntensity[powerId] || 20);
}

// After any god power, villagers sense a higher power
function _spreadAwe(people, state, intensity) {
  for (const p of people) {
    if (p.alive === false) continue;
    p.awe = Math.min(100, (p.awe || 0) + intensity);
    if (intensity > 30) {
      p.memories.push({ text: 'Felt the presence of something beyond this world', type: 'god', day: state.day });
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
  a.memories.push({ text: `Felt an irresistible pull toward ${b.name}`, type: 'god', day: state.day });
  b.memories.push({ text: `Felt an irresistible pull toward ${a.name}`, type: 'god', day: state.day });
  state.events.push({ day: state.day, hour: state.hour, participants: [a.name, b.name], summary: `💘 The gods drew ${a.name} and ${b.name} together!`, type: 'god' });
}
