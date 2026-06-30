// ════════════════════════════════════════════════════════════════════════════
// GOD AVATAR — the deity walks among the villagers
//
// A special person the human drives directly (WASD movement, typed dialogue).
// It lives in state.people so it renders and is perceived/talked-to like anyone,
// but `isAvatar` excludes it from all autonomous simulation. It can appear as a
// mysterious stranger (villagers treat it as a normal newcomer) or as an obvious
// deity (its words carry awe and reputation weight).
// ════════════════════════════════════════════════════════════════════════════

import { LOCATIONS, MAP_W, MAP_H, TERRAIN, LIFE_STAGES } from '../utils/constants.js';
import { generateAvatarReply } from './ai.js';
import { distBetween, clamp, locationAt } from './movement.js';
import { addMemory, setEmote } from './memory.js';
import { pickModelWeighted } from './models.js';

const AVATAR_ID = 999999;

// Create and place the avatar near the campfire. `divine` chooses how villagers
// perceive it. Returns the new state (avatar appended to people).
export function spawnAvatar(state, { divine = false, name } = {}) {
  if (state.people.some(p => p.isAvatar)) return state; // only one at a time
  const cf = LOCATIONS.CAMPFIRE;
  const avatar = {
    id: AVATAR_ID,
    isAvatar: true,
    divine,
    name: name || (divine ? 'The Presence' : 'Wanderer'),
    gender: 'other',
    age: 0,
    lifeStage: LIFE_STAGES.ADULT,
    color: divine ? 0xffe066 : 0xcccccc,
    traits: [], values: [],
    x: cf.x, y: cf.y,
    targetX: null, targetY: null,
    currentLocation: 'Campfire',
    mood: divine ? 'loving' : 'neutral',
    activity: 'idle',
    alive: true,
    sleeping: false, eating: false, sick: false,
    conversationId: null, conversationCooldown: 0,
    relationships: {}, reputationBeliefs: {},
    memories: [], conversationLog: [],
    skills: {}, inventory: {}, larder: {},
    hunger: 0, tiredness: 0, loneliness: 0,
    injury: 0, frailty: 0, awe: 0,
    emote: null, emoteTimer: 0,
    partner: null, home: null, children: [], parents: [],
    // a model so the avatar could (later) speak autonomously; harmless if unused
    model: pickModelWeighted(state.modelStats),
    speechStyle: divine ? 'Speaks with calm, weighty certainty.' : 'Speaks plainly, like a traveler.',
  };
  // seed a fresh stranger relationship both ways so rapport can actually build
  // across visits (villagers start knowing nothing about this newcomer).
  for (const v of state.people) {
    if (v.isAvatar) continue;
    avatar.relationships[v.name] = blankRel('stranger');
    v.relationships[avatar.name] = blankRel('stranger');
  }
  return { ...state, people: [...state.people, avatar], avatarId: AVATAR_ID };
}

// A neutral relationship record (mirrors initRelationships' shape).
export function blankRel(stage = 'stranger') {
  return { affection: 45, trust: 45, attraction: 0, familiarity: 0, stage, jealousy: 0 };
}

export function despawnAvatar(state) {
  const avatar = getAvatar(state);
  if (!avatar) return state;
  // Villagers NOTICE the stranger/presence vanish. Anyone who was near reacts:
  // a normal stranger leaving is mildly notable; a divine presence vanishing is
  // eerie and memorable. This also releases anyone still flagged in the convo.
  const convo = state.activeConversations.find(c => c.avatar);
  const knewThem = new Set(convo?.participants || []);
  for (const p of state.people) {
    if (p.isAvatar) continue;
    if (p.conversationId === convo?.id) p.conversationId = null; // release from avatar chat
    const wasNear = distBetween(p, avatar) < 7;
    if (!wasNear && !knewThem.has(p.name)) continue;
    if (avatar.divine) {
      addMemory(p, `The presence vanished as suddenly as it came. Where did it go?`, 'god', state.day,
        { location: p.currentLocation, valence: 1 });
      p.awe = Math.min(100, (p.awe || 0) + 8);
      p.mood = 'thoughtful';
      setEmote(p, 'sparkle', 20);
    } else {
      addMemory(p, `That stranger, ${avatar.name}, is gone. Didn't even say goodbye.`, 'life', state.day,
        { location: p.currentLocation, valence: 0.2 });
      setEmote(p, 'thought', 16);
    }
    p.thought = avatar.divine ? 'The presence... it left. I felt it.' : `Where did ${avatar.name} go?`;
  }
  return {
    ...state,
    people: state.people.filter(p => !p.isAvatar),
    activeConversations: state.activeConversations.filter(c => !c.avatar),
    avatarId: null,
  };
}

export function getAvatar(state) {
  return state.people.find(p => p.isAvatar) || null;
}

// Move the avatar by a tile-space delta (called from the keyboard loop). Clamps
// to the map and routes around water using the same walkable check as villagers.
export function moveAvatar(state, dx, dy) {
  const a = getAvatar(state);
  if (!a) return state;
  const nx = clamp(a.x + dx, 0, MAP_W - 1);
  const ny = clamp(a.y + dy, 0, MAP_H - 1);
  // don't walk into water (gods can, but it looks odd); allow if no better option
  if (state.terrain?.[Math.round(ny)]?.[Math.round(nx)]?.type !== TERRAIN.WATER) {
    a.x = nx; a.y = ny;
  } else {
    // allow axis-only slide so movement doesn't feel stuck against the shore
    if (state.terrain?.[Math.round(a.y)]?.[Math.round(nx)]?.type !== TERRAIN.WATER) a.x = nx;
    else if (state.terrain?.[Math.round(ny)]?.[Math.round(a.x)]?.type !== TERRAIN.WATER) a.y = ny;
  }
  a.currentLocation = locationAt(a.x, a.y);
  return state;
}

// A human-authored avatar line → nearby villagers hear it and reply via their own
// LLMs. The avatar's words land as memories and (optionally, when divine) shift
// mood/awe/reputation. Drives one round: avatar speaks, then each nearby villager
// who chooses to responds. Returns updated state via onUpdate, like runConversation.
export async function avatarSpeak(gameRef, text, onUpdate, signal) {
  const cs = gameRef.current;
  const avatar = getAvatar(cs);
  if (!avatar || !text?.trim()) return;

  // who's close enough to hear (a bit generous on the larger map so you don't
  // have to stand on top of someone)
  const HEAR_RANGE = 7;
  const listeners = cs.people.filter(p =>
    !p.isAvatar && p.alive !== false && p.lifeStage !== LIFE_STAGES.BABY &&
    distBetween(avatar, p) < HEAR_RANGE && !p.sleeping);

  // nobody in earshot — give clear feedback instead of silently doing nothing
  // (a common confusion on the big map: the avatar speaks to empty air).
  if (listeners.length === 0) {
    let convo0 = cs.activeConversations.find(c => c.avatar);
    if (!convo0) {
      const cid = cs.nextConvoId;
      gameRef.current = { ...cs, nextConvoId: cid + 1 };
      convo0 = { id: cid, participants: [avatar.name], lines: [], location: avatar.currentLocation, startTick: cs.tick, active: true, avatar: true };
      gameRef.current = { ...gameRef.current, activeConversations: [...gameRef.current.activeConversations, convo0] };
    }
    convo0.lines.push({ speaker: avatar.name, text: text.trim(), thought: null, mood: avatar.mood, addressedTo: 'everyone' });
    convo0.lines.push({ speaker: 'narrator', text: 'No one is close enough to hear. Walk nearer to a villager (WASD).', thought: null, mood: null });
    setEmote(avatar, 'sparkle', 10);
    pushAvatarConvo(gameRef, convo0);
    onUpdate?.();
    return;
  }

  // find or open a conversation anchored on the avatar
  let convo = cs.activeConversations.find(c => c.participants.includes(avatar.name));
  if (!convo) {
    const convoId = cs.nextConvoId;
    gameRef.current = { ...cs, nextConvoId: convoId + 1 };
    convo = {
      id: convoId,
      participants: [avatar.name, ...listeners.map(p => p.name)],
      lines: [], location: avatar.currentLocation, startTick: cs.tick, active: true, avatar: true,
    };
    gameRef.current = { ...gameRef.current, activeConversations: [...gameRef.current.activeConversations, convo] };
  } else {
    // refresh the listener roster as the avatar moves around
    for (const l of listeners) if (!convo.participants.includes(l.name)) convo.participants.push(l.name);
  }

  // record the avatar's spoken line
  convo.lines.push({ speaker: avatar.name, text: text.trim(), thought: null, mood: avatar.mood, addressedTo: 'everyone' });
  setEmote(avatar, 'sparkle', 12);

  // the divine word leaves a mark on everyone who heard it, and we LOCK them into
  // the avatar conversation (conversationId) so the autonomous loop can't grab
  // them mid-reply — this was the race that trampled their state.
  for (const l of listeners) {
    l.conversationId = convo.id;
    addMemory(l, `${avatar.divine ? 'A divine voice' : avatar.name} said: "${text.trim().slice(0, 80)}"`,
      avatar.divine ? 'god' : 'conversation', cs.day, { location: avatar.currentLocation, valence: avatar.divine ? 1.5 : 0.3 });
    if (avatar.divine) { l.awe = Math.min(100, (l.awe || 0) + 12); }
  }
  pushAvatarConvo(gameRef, convo);
  onUpdate?.();

  // each listener gets a chance to reply (in proximity order), via their own model.
  // Wrapped in try/finally so a thrown error mid-reply (e.g. a malformed AI result
  // being dereferenced) can never leave listeners locked with conversationId set —
  // which would silently exclude them from all future ticks forever.
  const history = convo.lines.map(li => ({ speaker: li.speaker, text: li.text }));
  try {
    for (const listener of listeners.sort((a, b) => distBetween(avatar, a) - distBetween(avatar, b)).slice(0, 3)) {
      if (signal?.aborted) break;
      // the player may have despawned the avatar mid-loop — stop cleanly if so
      if (!getAvatar(gameRef.current)) break;
      const others = [avatar, ...listeners.filter(p => p !== listener)];
      // generateGroupDialogue appends the reply to `history` itself, so we pass it
      // through and DON'T push again (that caused duplicate lines in the prompt).
      const result = await generateAvatarReply(listener, avatar, others, cs, history, signal);
      if (!result || !result.dialogue?.trim()) continue;
      convo.lines.push({ speaker: listener.name, text: result.dialogue.trim(), thought: result.internal_thought, mood: result.mood_after, addressedTo: avatar.name });
      listener.mood = result.mood_after || listener.mood;
      listener.thought = result.internal_thought || listener.thought;
      // talking with the avatar actually builds a relationship now (rapport across
      // visits). Apply the LLM's deltas to the listener→avatar relationship.
      applyAvatarRelationship(listener, avatar, result);
      pushAvatarConvo(gameRef, convo);
      onUpdate?.();
    }
  } finally {
    // release listeners back to normal life once the exchange settles, with a short
    // cooldown so they don't immediately get yanked into an autonomous chat.
    for (const l of listeners) {
      if (l.conversationId === convo.id) { l.conversationId = null; l.conversationCooldown = 8 + Math.floor(Math.random() * 6); }
    }
  }
}

// Apply the LLM's relationship deltas from an avatar reply to the listener's
// view of the avatar (the entry is seeded in spawnAvatar, so it always exists).
function applyAvatarRelationship(listener, avatar, result) {
  const rel = listener.relationships[avatar.name];
  if (!rel) return;
  const changes = result.relationship_changes?.[avatar.name] || {};
  rel.affection = clamp(rel.affection + (changes.affection || 0), 0, 100);
  rel.trust = clamp(rel.trust + (changes.trust || 0), 0, 100);
  rel.attraction = clamp(rel.attraction + (changes.attraction || 0), 0, 100);
  rel.familiarity = clamp(rel.familiarity + 3, 0, 100); // meeting them builds familiarity
  if (rel.familiarity > 20 && rel.stage === 'stranger') rel.stage = 'acquaintance';
}

// PROVE IT — a visible miracle performed BY the avatar, for the villagers who
// demand proof that this stranger is what they claim. Unlike the global god
// powers, this is localized and ATTRIBUTED to the avatar by name, so witnesses
// connect the wonder to the figure standing in front of them and start to
// believe. Heals, feeds, and floods nearby villagers with awe + a heavy memory.
// Returns the count of witnesses (so the UI can react).
export function performAvatarMiracle(gameRef) {
  const cs = gameRef.current;
  const avatar = getAvatar(cs);
  if (!avatar) return 0;
  const RANGE = 8;
  const witnesses = cs.people.filter(p =>
    !p.isAvatar && p.alive !== false && distBetween(avatar, p) < RANGE);

  // a light-burst particle cue on the avatar itself
  setEmote(avatar, 'sparkle', 60);

  let convo = cs.activeConversations.find(c => c.avatar);
  if (!convo) {
    const cid = cs.nextConvoId;
    gameRef.current = { ...cs, nextConvoId: cid + 1 };
    convo = { id: cid, participants: [avatar.name], lines: [], location: avatar.currentLocation, startTick: cs.tick, active: true, avatar: true };
    gameRef.current = { ...gameRef.current, activeConversations: [...gameRef.current.activeConversations, convo] };
  }
  convo.lines.push({ speaker: 'narrator', text: `${avatar.name} raises a hand — light pours out. Wounds close, hunger fades, the air hums.`, thought: null, mood: null });

  for (const p of witnesses) {
    // the wonder itself: full relief + healing, the kind no mortal could do
    p.hunger = 0;
    p.tiredness = Math.max(0, p.tiredness - 40);
    p.health = 100;
    p.injury = 0;
    p.sick = false; p.sickTimer = 0;
    p.awe = Math.min(100, (p.awe || 0) + 55);
    p.mood = 'excited';
    setEmote(p, 'sparkle', 50);
    // a heavy, lasting memory tied to THIS figure — the seed of belief
    addMemory(p, `Saw ${avatar.name} work a miracle before my eyes — light, healing, no trick. They are no ordinary stranger.`,
      'god', cs.day, { location: avatar.currentLocation, valence: 3 });
    // their trust in the avatar leaps (belief)
    const rel = p.relationships[avatar.name] || (p.relationships[avatar.name] = blankRel('acquaintance'));
    rel.trust = clamp(rel.trust + 30, 0, 100);
    rel.affection = clamp(rel.affection + 15, 0, 100);
    rel.familiarity = clamp(rel.familiarity + 10, 0, 100);
    p.thought = `It's real. ${avatar.name} is real.`;
  }
  cs.events.push({ day: cs.day, hour: cs.hour, participants: [avatar.name, ...witnesses.map(w => w.name)],
    summary: `🌟 ${avatar.name} performed a miracle before ${witnesses.length} witness${witnesses.length === 1 ? '' : 'es'}!`, type: 'god' });
  const list = gameRef.current.activeConversations.map(c => c.id === convo.id ? { ...convo, lines: [...convo.lines] } : c);
  gameRef.current = { ...gameRef.current, activeConversations: list };
  return witnesses.length;
}

// End the avatar conversation, releasing listeners (called on despawn or "leave").
export function endAvatarConversation(state) {
  const convo = state.activeConversations.find(c => c.avatar);
  if (!convo) return state;
  convo.active = false;
  return { ...state, activeConversations: state.activeConversations.filter(c => !c.avatar) };
}

function pushAvatarConvo(gameRef, convo) {
  const list = gameRef.current.activeConversations.map(c =>
    c.id === convo.id ? { ...convo, lines: [...convo.lines], participants: [...convo.participants] } : c);
  gameRef.current = { ...gameRef.current, activeConversations: list };
}
