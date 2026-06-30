import { getProvider } from './providers/provider.js';

// All model calls go through the active provider (OpenRouter by default,
// swappable via VITE_AI_PROVIDER). `model` lets a specific agent think with
// their own assigned model; providers that don't support per-call models ignore
// it and use their default.
function callLLM(systemPrompt, userPrompt, temperature = 0.9, maxTokens = 500, label, signal, model) {
  return getProvider().complete({ system: systemPrompt, user: userPrompt, temperature, maxTokens, label, signal, model });
}

// ── helpers ──

function getPastConversations(person, otherNames, limit = 2) {
  if (!person.conversationLog?.length) return '';
  const relevant = person.conversationLog
    .filter(c => otherNames.some(n => c.participants.includes(n)))
    .slice(-limit);
  if (!relevant.length) return 'You have never spoken to these people before.';
  return relevant.map(c => {
    const lines = c.lines.slice(-5).map(l => `  ${l.speaker}: "${l.text}"`).join('\n');
    return `[Day ${c.day}, ${c.location}]\n${lines}`;
  }).join('\n\n');
}

function formatMemories(person, limit = 6) {
  if (!person.memories?.length) return '';
  return person.memories.slice(-limit).map(m => `[Day ${m.day}] ${m.text}`).join('\n');
}

// Memories the speaker shares with a specific person — the raw material for
// "remember when..." references in dialogue (#3). Surfaces memories that name the
// person, plus heavy collective events (deaths, dangers, near-starvation) that
// everyone present lived through. Ranked by current decayed weight.
function getSharedExperiences(person, otherName, limit = 3) {
  if (!person.memories?.length) return '';
  const COLLECTIVE = new Set(['death', 'danger']);
  const scored = person.memories
    .filter(m => (m.text && m.text.includes(otherName)) || COLLECTIVE.has(m.type))
    .map(m => ({ m, w: m.weight ?? Math.abs(m.valence ?? 0) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, limit)
    .map(({ m }) => `[Day ${m.day}] ${m.text}`);
  return scored.join('\n');
}

// Summarize how the person feels about places based on anchored memories.
// Informs the LLM without forcing it — the model can still choose to go anywhere.
function formatPlaceFeelings(person) {
  if (!person.memories?.length) return '';
  const byPlace = {};
  for (const m of person.memories) {
    if (!m.location || !m.valence) continue;
    byPlace[m.location] = (byPlace[m.location] || 0) + (m.weight ?? Math.abs(m.valence)) * Math.sign(m.valence);
  }
  const lines = Object.entries(byPlace)
    .filter(([, v]) => Math.abs(v) > 0.5)
    .map(([place, v]) => `${place}: ${v > 0 ? 'fond of it' : 'uneasy about it'}`);
  return lines.length ? lines.join(', ') : '';
}

function formatInventory(person) {
  const parts = [];
  for (const [k, v] of Object.entries(person.inventory || {})) { if (v > 0) parts.push(`${v} ${k}`); }
  for (const [k, v] of Object.entries(person.larder || {})) { if (v > 0) parts.push(`${v} ${k}`); }
  return parts.join(', ') || 'nothing';
}

function describeActivity(p) {
  if (p.alive === false) return 'dead';
  if (p.sleeping) return 'sleeping';
  if (p.eating) return 'eating';
  if (p.sick) return 'sick';
  if (p.buildProject?.phase && p.buildProject.phase !== 'complete') return `building (${p.buildProject.type})`;
  return p.activity || 'idle';
}

// The single word the village most associates with someone, from a reputation
// record { generous, kind, skilled, reliable, brave }. Mirrors the sim's own
// reputationLabel (kept here to avoid a circular import).
const REP_POS = { generous: 'generous', kind: 'kind', skilled: 'highly skilled', reliable: 'dependable', brave: 'brave' };
const REP_NEG = { generous: 'selfish', kind: 'cold', skilled: 'unskilled', reliable: 'unreliable', brave: 'timid' };
function repLabelFrom(rec) {
  if (!rec) return null;
  let best = null, mag = 12;
  for (const d of Object.keys(REP_POS)) {
    if (Math.abs(rec[d] || 0) > mag) { mag = Math.abs(rec[d]); best = { d, v: rec[d] }; }
  }
  return best ? (best.v > 0 ? REP_POS[best.d] : REP_NEG[best.d]) : null;
}

function describeWorld(person, allPeople, state) {
  const reputation = state.reputation || {};
  const others = allPeople
    // exclude the god avatar: it's player-controlled and shouldn't leak into a
    // villager's autonomous world-reasoning. Direct encounters use a dedicated
    // avatar-reply prompt instead.
    .filter(p => p.name !== person.name && p.alive !== false && !p.isAvatar)
    .map(p => {
      const rel = person.relationships?.[p.name];
      const stage = rel?.stage || 'stranger';
      const extras = [];
      if (person.partner === p.name) extras.push('partner');
      if (rel?.affection > 65) extras.push('close');
      if (rel?.attraction > 60) extras.push('attracted');
      if (p.sick) extras.push('sick');
      if (p.injury > 25) extras.push('injured');
      // private belief (gossip-shaped) takes priority over the village consensus
      const rep = repLabelFrom(person.reputationBeliefs?.[p.name]) || repLabelFrom(reputation[p.name]);
      if (rep) extras.push(`known as ${rep}`);
      const ex = extras.length ? ` (${extras.join(', ')})` : '';
      return `${p.name} — ${stage}${ex}, at ${p.currentLocation}, ${describeActivity(p)}`;
    }).join('\n');

  const wildlife = (state.wildlife || [])
    .filter(w => w.alive !== false)
    .map(w => `${w.type} near ${w.currentLocation}${w.tamed ? ' (tamed)' : ''}`)
    .join(', ');

  // Buildings the person could plausibly know about: ones near them now, plus
  // their own home wherever it is. Villagers are NOT omniscient about every
  // structure on the map — only what's in view / nearby landmarks they'd have
  // passed. Ownership is shown so they know whose house it is.
  const KNOWN_BUILD_RADIUS = 12; // stationary landmarks are knowable from farther than live sight
  const describeBuilding = (b) => {
    const mine = b.owners?.includes(person.name);
    const who = mine ? 'yours' : (b.owners?.length ? b.owners.join('/') + "'s" : 'unclaimed');
    return `${b.type || 'home'} at (${Math.round(b.x)},${Math.round(b.y)}) — ${who}`;
  };
  const nearbyBuildings = (state.buildings || []).filter(b => {
    if (b.owners?.includes(person.name)) return true; // always aware of your own home
    const dx = b.x - person.x, dy = b.y - person.y;
    return Math.sqrt(dx * dx + dy * dy) <= KNOWN_BUILD_RADIUS;
  });
  const buildings = nearbyBuildings.map(describeBuilding).join(', ');

  return { others, wildlife: wildlife || 'none spotted', buildings: buildings || 'none nearby' };
}

function personContext(person) {
  const hungerDesc = person.hunger > 70 ? 'very hungry' : person.hunger > 40 ? 'getting hungry' : 'not hungry';
  const tiredDesc = person.tiredness > 70 ? 'exhausted' : person.tiredness > 40 ? 'tired' : 'rested';
  const lonelyDesc = person.loneliness > 60 ? 'lonely' : person.loneliness > 30 ? 'could use company' : 'socially fine';
  const sickDesc = person.sick ? ' You are sick and weak.' : '';
  const griefDesc = person.griefTimer > 0 ? ` Grieving ${person.griefTarget}.` : '';
  const aweDesc = person.awe > 30 ? ' You sense something divine watching.' : '';
  const buildDesc = person.buildProject?.phase && person.buildProject.phase !== 'complete'
    ? ` Building a ${person.buildProject.type} (${person.buildProject.phase}). Materials still needed: wood=${Math.max(0, (person.buildProject.materialsNeeded?.wood || 0) - (person.inventory?.wood || 0))}, stone=${Math.max(0, (person.buildProject.materialsNeeded?.stone || 0) - (person.inventory?.stone || 0))}, thatch=${Math.max(0, (person.buildProject.materialsNeeded?.thatch || 0) - (person.inventory?.thatch || 0))}.`
    : '';
  const homeDesc = person.home ? `You have a home (${person.home.type || 'shelter'}).` : 'You have no home.';
  const goals = person.ambitions?.filter(a => !a.completed).map(a => a.label).join(', ') || 'none right now';
  const skills = Object.entries(person.skills || {}).filter(([, v]) => v > 3).map(([k, v]) => `${k}:${Math.round(v)}`).join(', ') || 'none yet';

  return `${hungerDesc}. ${tiredDesc}. ${lonelyDesc}.${sickDesc}${griefDesc}${aweDesc}${buildDesc} ${homeDesc}
Carrying: ${formatInventory(person)}.
Skills: ${skills}. Goals: ${goals}.`;
}

// ── MAIN DECISION — the character's brain ──

export async function generateAction(person, allPeople, worldState, signal) {
  const world = describeWorld(person, allPeople, worldState);

  const systemPrompt = `You ARE ${person.name}. You are a real person in a small primitive settlement. You must decide what to do RIGHT NOW based on your needs, personality, memories, relationships, and what's happening around you.

WHO YOU ARE:
${person.name}, ${person.gender}, ${person.age} years old (${person.lifeStage}).
Personality: ${person.traits.join(', ')}.
Values: ${person.values.join(', ')}.
Habits: ${person.quirks}.
Background: ${person.background}
${person.partner ? `Partner: ${person.partner}.` : 'Single.'}
${person.children?.length ? `Children: ${person.children.join(', ')}.` : ''}

YOUR STATE RIGHT NOW:
Mood: ${person.mood}. ${personContext(person)}

You're being asked to decide because something INTERESTING is happening — a choice with no obvious answer. Pure survival reflexes (collapsing from exhaustion, eating when starving, fleeing a storm) are handled automatically; don't waste this moment on them. THINK LIKE A REAL HUMAN about what YOU want here:
- Competing pulls (hungry but also lonely? building but tired? what wins for you right now?)
- Relationships and feelings (pursue someone, mend a rift, avoid someone, comfort a friend)
- Your projects and ambitions (push them forward, or let them go)
- Sometimes just do nothing — sit, think, wander aimlessly. Real people don't optimize every minute.

${worldState.specialty ? `You've become the village's go-to for ${worldState.specialty} — it's part of who you are now.` : ''}
${worldState.myReputation ? `Around the village, people think of you as ${worldState.myReputation}. That reputation follows you.` : ''}
You can also UPDATE YOUR GOALS if they no longer make sense. Drop goals that feel wrong, add new ones based on what's happened to you.
${person.home ? `You have a home. In bad weather or danger you could invite a homeless person to shelter with you (action "offer_shelter", target their name) — a real kindness, or not your nature. Your call.` : ''}`;

  const learnedStr = (worldState.learned || []).filter(l => Math.abs(l.value) > 0.3)
    .map(l => `${l.action} (${l.value > 0 ? 'paying off' : 'disappointing'})`).join(', ');
  const larder = worldState.larder || {};
  const larderStr = Object.entries(larder).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ') || 'bare';

  const f = worldState.field;
  const fieldStr = !f ? '' : !f.planted
    ? 'The field is fallow — nobody has sown it. Crops keep best through winter.'
    : f.stage >= 1
      ? 'The field is RIPE — ready to harvest for crops!'
      : `The field is sown and ${Math.round(f.stage * 100)}% grown — it could use tending.`;

  const sp = worldState.specialists || {};
  const spLines = [];
  if (sp.healer) spLines.push(`best healer: ${sp.healer}`);
  if (sp.hunter) spLines.push(`best hunter: ${sp.hunter}`);
  if (sp.builder) spLines.push(`best builder: ${sp.builder}`);
  if (sp.forager) spLines.push(`best forager: ${sp.forager}`);
  const specialistStr = spLines.length ? spLines.join(', ') : '';

  const userPrompt = `CURRENT SITUATION:
Location: ${person.currentLocation || 'settlement'}.
Time: ${worldState.timeOfDay} (${worldState.hour}:${String(worldState.minute).padStart(2,'0')}), Day ${worldState.day}, ${worldState.season}. Weather: ${worldState.weather}.
Village larder: ${larderStr}.${fieldStr ? `\nThe Field: ${fieldStr}` : ''}${learnedStr ? `\nWHAT YOU'VE LEARNED works ${worldState.season}: ${learnedStr}.` : ''}${specialistStr ? `\nWHO THE VILLAGE RELIES ON — ${specialistStr}. If you need help (sick, hungry, building), it makes sense to seek the right person.` : ''}

PEOPLE:
${world.others || 'Nobody around.'}

WILDLIFE:
${world.wildlife}

BUILDINGS:
${world.buildings}

PLACES YOU CAN GO:
- Grove: chop wood, collect lumber
- Rock Seat: collect stones, sit and think
- Meadow: gather thatch/grass, relax
- Berry Bush: forage for berries and herbs
- Fishing Spot: catch fish
- Field: sow, tend, and harvest crops (slow but a big, long-keeping payoff)
- Campfire: socialize, cook, warm up
- Well: get water
- Pond: fish, reflect, be alone

YOUR MEMORIES:
${formatMemories(person, 6) || 'Nothing yet — this is all new.'}
${formatPlaceFeelings(person) ? `\nHOW YOU FEEL ABOUT PLACES: ${formatPlaceFeelings(person)}` : ''}

What do you do? Think step by step as ${person.name}, then decide.

JSON response:
{
  "action": "go_to/seek_person/rest/chop_wood/collect_stone/gather_thatch/gather_food/fish/farm/build/hunt/explore/sit_and_think/heal_person/craft/offer_shelter",
  "target": "location name or person name or animal type",
  "reason": "why — one sentence, in first person as ${person.name}",
  "mood": "your mood now",
  "thought": "what you're privately thinking",
  "update_goals": [{"action": "add/drop", "goal": "description"}] or null
}`;

  return callLLM(systemPrompt, userPrompt, 0.9, 400, 'action', signal, person.model);
}

// ── DIALOGUE ──

export async function generateGroupDialogue(speaker, otherParticipants, allPeople, context, history, signal) {
  const otherNames = otherParticipants.map(p => p.name);
  const pastConvos = getPastConversations(speaker, otherNames, 2);

  const othersDesc = otherParticipants.map(p => {
    const rel = speaker.relationships?.[p.name] || {};
    const feelings = [];
    if (rel.affection > 70) feelings.push('close');
    else if (rel.affection > 55) feelings.push('friendly');
    else if (rel.affection < 30) feelings.push('wary');
    if (rel.attraction > 65) feelings.push('attracted');
    if (speaker.partner === p.name) feelings.push('partner');
    if (rel.jealousy > 40) feelings.push('jealous');
    const rep = repLabelFrom(speaker.reputationBeliefs?.[p.name]);
    if (rep) feelings.push(`you think of them as ${rep}`);
    return `${p.name} (${p.gender}, ${p.age}) — ${rel.stage || 'stranger'}${feelings.length ? ', ' + feelings.join(', ') : ''}. Currently ${describeActivity(p)}.`;
  }).join('\n');

  // shared history with each person — the raw material for "remember when..."
  const sharedHistory = otherParticipants
    .map(p => { const s = getSharedExperiences(speaker, p.name); return s ? `With ${p.name}:\n${s}` : ''; })
    .filter(Boolean).join('\n\n');

  const systemPrompt = `You ARE ${speaker.name}. You are talking with people in your settlement. Be completely natural — talk like a REAL person, not a character in a story.

WHO YOU ARE:
${speaker.name}, ${speaker.gender}, ${speaker.age}. ${speaker.lifeStage}.
Personality: ${speaker.traits.join(', ')}.
How you talk: ${speaker.speechStyle}
Mood: ${speaker.mood}. ${personContext(speaker)}

Talk about REAL things:
- What you did today, what you're working on
- How you're actually feeling (tired, hungry, worried, bored)
- Opinions about the settlement, weather, food situation
- Ask about what they've been doing
- Reference past conversations you've had with them
- Gossip, complaints, plans, observations
- Sometimes be awkward, trail off, change the subject
- DON'T always be poetic or philosophical. Be mundane sometimes.

STAY GROUNDED — this is a small primitive settlement. Only mention things that
actually exist here: the people listed, the places (Campfire, Grove, Meadow,
Berry Bush, Fishing Spot, Pond, Well, Rock Seat, Field), real food (berries,
fish, meat, crops), wood/stone/thatch, the weather and season. DO NOT invent
feasts, festivals, gods, religions, towns, shops, or mythical creatures.
You CAN bring up shared history — but ONLY events that appear in your memories or
the "THINGS YOU'VE BEEN THROUGH TOGETHER" list below ("remember the winter we
nearly starved?", "you've seemed different since the wolf"). Never invent a past
event that isn't written there. If you feel a "divine presence," it's only
because something genuinely strange just happened — don't manufacture it.`;

  const userPrompt = `TALKING WITH:
${othersDesc}

WHERE: ${context}

PAST CONVERSATIONS WITH THESE PEOPLE:
${pastConvos}
${sharedHistory ? `\nTHINGS YOU'VE BEEN THROUGH TOGETHER (you may reference these naturally — "remember when...", "you've been different since..."):\n${sharedHistory}\n` : ''}
${history.length > 0
  ? `THIS CONVERSATION SO FAR:\n${history.slice(-10).map(h => `${h.speaker}: ${h.text}`).join('\n')}\n\n${history[history.length - 1].speaker} just said: "${history[history.length - 1].text}"\nRESPOND DIRECTLY to that — answer their question, react to what they said, or build on it. Do NOT start a fresh greeting or repeat an earlier line. This is a back-and-forth, not a monologue.`
  : 'You just ran into each other. Say something natural — a greeting, a comment, or a question to get them talking.'}

${formatMemories(speaker, 3) ? `YOUR RECENT MEMORIES:\n${formatMemories(speaker, 3)}` : ''}

Say something as ${speaker.name}. 1-3 sentences, natural. ${history.length > 0 ? `You are REPLYING to ${history[history.length - 1].speaker} — actually engage with what they said.` : ''}

JSON:
{
  "dialogue": "what you say",
  "addressed_to": "name or 'everyone'",
  "mood_after": "happy/neutral/sad/excited/thoughtful/anxious/flirty/annoyed/lonely/content/jealous/heartbroken/loving",
  "internal_thought": "what you think but don't say",
  "relationship_changes": {
    ${otherParticipants.map(p => `"${p.name}": {"affection": 0, "trust": 0, "attraction": 0}`).join(',\n    ')}
  },
  "wants_to_continue": true or false
}`;

  // each speaker thinks with their own assigned model — distinct voices per line
  const result = await callLLM(systemPrompt, userPrompt, 0.95, 400, 'dialogue', signal, speaker.model);
  // some cheap models return JSON missing `dialogue` (or empty) — treat as a miss
  if (!result || typeof result.dialogue !== 'string' || !result.dialogue.trim()) return null;
  history.push({ speaker: speaker.name, text: result.dialogue, thought: result.internal_thought });
  if (history.length > 30) history.splice(0, history.length - 30);
  return result;
}

// ── AVATAR REPLY ──
// A villager replies to the god's avatar walking among them. This needs its OWN
// prompt: the normal dialogue prompt forbids acknowledging gods/divine presences
// (to keep autonomous chatter grounded), which directly contradicts a stranger or
// presence actually standing there. Here we explicitly frame the encounter so the
// villager reacts in-character — wary/curious to a stranger, awed/unsettled to a
// presence — while staying otherwise grounded in their primitive world.
export async function generateAvatarReply(listener, avatar, others, state, history, signal) {
  const rel = listener.relationships?.[avatar.name] || {};
  const familiarity = rel.familiarity > 40 ? 'You have spoken with them several times now and are growing used to them.'
    : rel.familiarity > 10 ? 'You have met them before, once or twice.'
    : 'You have never met them before.';

  const othersDesc = others.filter(p => p.name !== avatar.name).map(p => {
    const r = listener.relationships?.[p.name] || {};
    return `${p.name} (${r.stage || 'stranger'})`;
  }).join(', ');

  const divineFrame = avatar.divine
    ? `Standing before you is something that is NOT an ordinary person — a powerful, luminous PRESENCE that calls itself "${avatar.name}". You can feel it in your chest; it does not seem entirely mortal. You might be awed, frightened, reverent, skeptical, or overwhelmed — react however ${listener.name} truly would. ${listener.awe > 40 ? 'You already sense a higher power has been watching the village.' : ''}`
    : `Standing before you is a STRANGER who calls themselves "${avatar.name}" — someone you don't recognize from your small settlement, which almost never sees newcomers. You might be curious, cautious, welcoming, or suspicious — react however ${listener.name} truly would.`;

  const systemPrompt = `You ARE ${listener.name}. ${listener.gender}, ${listener.age}, ${listener.lifeStage}.
Personality: ${(listener.traits || []).join(', ')}. How you talk: ${listener.speechStyle}
Mood: ${listener.mood}. ${personContext(listener)}

${divineFrame}
${familiarity}

This is REAL and happening right now — do NOT pretend they aren't there. Speak to them directly, in your own voice, the way ${listener.name} actually would. Stay grounded in your primitive world otherwise (you still only know wood, stone, fire, plants, animals, water, the people and places of your settlement). Don't invent unrelated festivals or faraway towns.`;

  const userPrompt = `WHERE: ${avatar.currentLocation}. ${state.timeOfDay}, day ${state.day}, ${state.weather}.
${othersDesc ? `Others nearby: ${othersDesc}.` : 'No one else is close by.'}

THE CONVERSATION SO FAR:
${history.slice(-8).map(h => `${h.speaker}: "${h.text}"`).join('\n')}

${history.length ? `${history[history.length - 1].speaker} just said: "${history[history.length - 1].text}"` : ''}
Respond directly to what was just said — react to it, answer it, or ask something back. 1-3 sentences.

JSON:
{
  "dialogue": "what you say to ${avatar.name}",
  "addressed_to": "${avatar.name}",
  "mood_after": "happy/neutral/sad/excited/thoughtful/anxious/flirty/annoyed/lonely/content/jealous/heartbroken/loving",
  "internal_thought": "what you privately think about this encounter",
  "relationship_changes": { "${avatar.name}": {"affection": 0, "trust": 0, "attraction": 0} },
  "wants_to_continue": true or false
}`;

  const result = await callLLM(systemPrompt, userPrompt, 0.95, 350, 'avatar', signal, listener.model);
  if (!result || typeof result.dialogue !== 'string' || !result.dialogue.trim()) return null;
  history.push({ speaker: listener.name, text: result.dialogue });
  if (history.length > 30) history.splice(0, history.length - 30);
  return result;
}

// ── GOSSIP (#2) ──
// The speaker passes along their read on an absent third party. The returned
// `lean` lets the listener nudge their own belief toward the speaker's view —
// this is how reputation spreads (and distorts) without direct interaction.
export async function generateGossip(speaker, listener, absentName, state, signal) {
  const belief = repLabelFrom(speaker.reputationBeliefs?.[absentName]) || repLabelFrom((state.reputation || {})[absentName]);
  const rel = speaker.relationships?.[absentName] || {};
  const feel = rel.affection > 60 ? 'you like them' : rel.affection < 30 ? 'you don\'t much like them' : 'you\'re neutral on them';
  const systemPrompt = `You ARE ${speaker.name} (${speaker.traits.join(', ')}). How you talk: ${speaker.speechStyle}
You're talking with ${listener.name} and ${absentName} isn't here. People talk about each other when they're not around — that's just village life. Share what you actually think of ${absentName}.`;
  const userPrompt = `What you currently think of ${absentName}: ${belief ? `known to you as ${belief}` : 'no strong opinion yet'} (${feel}).
Say one natural, in-character line of gossip about ${absentName} to ${listener.name} — an opinion, a complaint, a bit of praise, or a worry. Keep it grounded in this small settlement.

JSON:
{
  "dialogue": "what you say about ${absentName}",
  "lean": "positive/negative/neutral",
  "about": "${absentName}"
}`;
  const result = await callLLM(systemPrompt, userPrompt, 0.95, 200, 'gossip', signal, speaker.model);
  if (!result || typeof result.dialogue !== 'string' || !result.dialogue.trim()) return null;
  return result;
}

// ── TEACHING (#7) ──
// An expert gives a novice a short lesson in a skill. Flavorful, and the caller
// rewards the novice's skill on a usable exchange.
export async function generateTeaching(teacher, student, skill, signal) {
  const systemPrompt = `You ARE ${teacher.name} (${teacher.traits.join(', ')}). How you talk: ${teacher.speechStyle}
You are the village's best at ${skill} (skill ${Math.round(teacher.skills?.[skill] || 0)}/100). ${student.name} is still learning it. Pass on something real and practical — the kind of tip you only know from doing it. Stay grounded in this primitive settlement.`;
  const userPrompt = `Teach ${student.name} one concrete thing about ${skill}, in your own voice. 1-2 sentences.

JSON:
{
  "dialogue": "what you say while teaching",
  "tip": "the practical lesson in a few words"
}`;
  const result = await callLLM(systemPrompt, userPrompt, 0.9, 200, 'teach', signal, teacher.model);
  if (!result || typeof result.dialogue !== 'string' || !result.dialogue.trim()) return null;
  return result;
}

// ── IDEATION (Phase 3) — constrained invention brainstorm ──
//
// The whole point is to constrain knowledge: the agent only knows what they've
// personally seen and what they already know how to do. We NEVER tell them
// what's possible or name any modern concept — they have to reach for it from
// raw observation. The system then maps whatever they say onto the hidden tech
// graph. A vague or off-graph idea is fine; the system just lets it fail.
export async function generateIdeation(person, { need, noticed, knownTechniques }, signal) {
  const systemPrompt = `You ARE ${person.name}, a person in a primitive settlement.
Personality: ${person.traits.join(', ')}. ${person.speechStyle}

You live in a PRIMITIVE settlement. You have NO concept of metal, gears, engines,
electricity, machines, chemistry, or any modern thing — those words mean nothing
to you. You only know what you have seen with your own eyes: wood, stone, clay,
fire, plants, animals, water, dirt, and the strange materials you've come across.
You think in terms of trying things — heating, mixing, shaping, striking,
burying, soaking — to see what happens. You are resourceful and a little stubborn.`;

  const userPrompt = `You're frustrated: ${need}.

Things you've noticed out in the world (you don't know what they're good for):
${noticed.map(n => `- ${n}`).join('\n')}

What you already know how to do:
${knownTechniques.length ? knownTechniques.map(k => `- ${k}`).join('\n') : '- nothing special yet, just the basics'}

Is there something you could TRY making or doing with these — some experiment
that might make your life easier? Don't worry about whether it'll work. Describe
it the way YOU would, in plain words, as something you want to attempt.

Pick ONE simple action word for how you'd do it — one of: heat, grind, mix, dry,
soak, strike, bury, ferment, carve, weave. Name the few things (one to four) you'd
use, in your own words.

JSON:
{
  "idea": "one or two sentences, first person, what you want to try (e.g. 'I wonder if those green rocks would melt if I got the fire hot enough')",
  "making": "a few words naming the thing you're trying to make or do",
  "inputs": ["the materials you'd use, named the way you'd say them (e.g. 'the grey sticky earth')"],
  "process": "one action word from the list above",
  "feeling": "your mood about it"
}`;

  const result = await callLLM(systemPrompt, userPrompt, 1.0, 280, 'ideation', signal, person.model);
  if (!result || typeof result.idea !== 'string' || !result.idea.trim()) return null;
  return result;
}

// ── BUILD PLANNING ──

export async function generateBuildPlan(person, partner, worldState) {
  const systemPrompt = `${person.name} wants to build something. They have building skill ${Math.round(person.skills?.building || 0)}/100. ${partner ? `Building with ${partner.name} (skill ${Math.round(partner.skills?.building || 0)}).` : 'Alone.'}
${person.children?.length ? `Has ${person.children.length} children.` : ''}
Current buildings in settlement: ${(worldState?.buildings || []).map(b => b.type).join(', ') || 'none'}.

They can build ANYTHING that makes sense for a primitive settlement — not just homes. Think about what the settlement actually needs:
- Shelter/home if they don't have one
- Storage for food/materials
- Medicine/herb hut if people get sick
- Workshop for crafting tools
- Walls or fences for protection from wildlife
- Drying rack for preserving food
- Communal cooking area
- Whatever else makes sense

Materials: wood (from Grove), stone (from Rock Seat), thatch (from Meadow).`;

  const userPrompt = `What should ${person.name} build? Consider their skill, the settlement's needs, and what already exists.

JSON:
{
  "type": "descriptive name",
  "description": "what it is and why they're building it",
  "materials_needed": {"wood": number, "stone": number, "thatch": number},
  "estimated_quality": "crude/basic/decent/good/excellent"
}`;

  return callLLM(systemPrompt, userPrompt, 0.85, 300, 'build', undefined, person.model);
}
