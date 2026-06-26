const API_KEY = import.meta.env.VITE_OPENAI_API_KEY;
const API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4.1-nano';

async function callOpenAI(systemPrompt, userPrompt, temperature = 0.9, maxTokens = 500) {
  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature, max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    });
    if (!resp.ok) { console.warn('OpenAI API error:', resp.status, await resp.text()); return null; }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) { console.warn('AI error:', e); return null; }
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

function formatInventory(person) {
  const inv = person.inventory || {};
  const parts = [];
  for (const [k, v] of Object.entries(inv)) { if (v > 0) parts.push(`${v} ${k}`); }
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

function describeWorld(person, allPeople, state) {
  const others = allPeople
    .filter(p => p.name !== person.name && p.alive !== false)
    .map(p => {
      const rel = person.relationships?.[p.name];
      const stage = rel?.stage || 'stranger';
      const extras = [];
      if (person.partner === p.name) extras.push('partner');
      if (rel?.affection > 65) extras.push('close');
      if (rel?.attraction > 60) extras.push('attracted');
      if (p.sick) extras.push('sick');
      const ex = extras.length ? ` (${extras.join(', ')})` : '';
      return `${p.name} — ${stage}${ex}, at ${p.currentLocation}, ${describeActivity(p)}`;
    }).join('\n');

  const wildlife = (state.wildlife || [])
    .filter(w => w.alive !== false)
    .map(w => `${w.type} near ${w.currentLocation}${w.tamed ? ' (tamed)' : ''}`)
    .join(', ');

  const buildings = (state.buildings || [])
    .map(b => `${b.type || 'home'} at (${Math.round(b.x)},${Math.round(b.y)})${b.owners ? ' owned by ' + b.owners.join('/') : ''}`)
    .join(', ');

  return { others, wildlife: wildlife || 'none spotted', buildings: buildings || 'none built yet' };
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

export async function generateAction(person, allPeople, worldState) {
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

THINK LIKE A REAL HUMAN. Prioritize:
- Survival first (eat if hungry, sleep if exhausted, seek shelter in storms)
- Then current projects (if building, gather what you need)
- Then social needs (seek people if lonely, avoid if overwhelmed)
- Then long-term goals (learn skills, find partner, explore)
- Sometimes just do nothing — sit, think, wander aimlessly. Real people don't optimize every minute.

You can also UPDATE YOUR GOALS if they no longer make sense. Drop goals that feel wrong, add new ones based on what's happened to you.`;

  const userPrompt = `CURRENT SITUATION:
Location: ${person.currentLocation || 'settlement'}.
Time: ${worldState.timeOfDay} (${worldState.hour}:${String(worldState.minute).padStart(2,'0')}), Day ${worldState.day}, ${worldState.season}. Weather: ${worldState.weather}.
Village food supply: ${worldState.villageFood ?? 50}.

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
- Campfire: socialize, cook, warm up
- Well: get water
- Pond: fish, reflect, be alone

YOUR MEMORIES:
${formatMemories(person, 6) || 'Nothing yet — this is all new.'}

What do you do? Think step by step as ${person.name}, then decide.

JSON response:
{
  "action": "go_to/seek_person/rest/chop_wood/collect_stone/gather_thatch/gather_food/fish/build/hunt/explore/sit_and_think/heal_person/craft/tend_crops",
  "target": "location name or person name or animal type",
  "reason": "why — one sentence, in first person as ${person.name}",
  "mood": "your mood now",
  "thought": "what you're privately thinking",
  "update_goals": [{"action": "add/drop", "goal": "description"}] or null
}`;

  return callOpenAI(systemPrompt, userPrompt, 0.9, 400);
}

// ── DIALOGUE ──

export async function generateGroupDialogue(speaker, otherParticipants, allPeople, context, history) {
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
    return `${p.name} (${p.gender}, ${p.age}) — ${rel.stage || 'stranger'}${feelings.length ? ', ' + feelings.join(', ') : ''}. Currently ${describeActivity(p)}.`;
  }).join('\n');

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
- DON'T always be poetic or philosophical. Be mundane sometimes.`;

  const userPrompt = `TALKING WITH:
${othersDesc}

WHERE: ${context}

PAST CONVERSATIONS WITH THESE PEOPLE:
${pastConvos}

${history.length > 0 ? `THIS CONVERSATION:\n${history.slice(-10).map(h => `${h.speaker}: ${h.text}`).join('\n')}` : 'You just ran into each other. Say something natural — greeting, comment, question.'}

${formatMemories(speaker, 3) ? `YOUR RECENT MEMORIES:\n${formatMemories(speaker, 3)}` : ''}

Say something as ${speaker.name}. 1-3 sentences, natural.

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

  const result = await callOpenAI(systemPrompt, userPrompt, 0.95, 400);
  if (!result) return null;
  history.push({ speaker: speaker.name, text: result.dialogue, thought: result.internal_thought });
  if (history.length > 30) history.splice(0, history.length - 30);
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

  return callOpenAI(systemPrompt, userPrompt, 0.85, 300);
}
