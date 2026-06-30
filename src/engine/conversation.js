// ── Conversations & AI-driven actions ──
// The two big LLM-driven flows: a multi-speaker group conversation (with gossip,
// teaching, and recipe-teaching beats) and the per-agent action decision that the
// escalation gate routes to. Both mutate the live state through gameRef and call
// back via onUpdate, like the avatar flow. The widest import surface in the
// engine — it pulls from nearly every other module.

import { GATE, GOSSIP_CHANCE, LIFE_STAGES } from '../utils/constants.js';
import { nearestVisiblePrey } from './vision.js';
import { generateGroupDialogue, generateAction, generateGossip, generateTeaching } from './ai.js';
import { distBetween, clamp, setGoal, goToLocation, goToPerson } from './movement.js';
import { addMemory, personValence, setEmote } from './memory.js';
import { recordModelResult } from './models.js';
import { totalFood } from './food.js';
import { bumpReputation, pickGossipTarget, applyGossip, reputationLabel } from './reputation.js';
import { rewardAction, topSkill, bestSpecialist, qBestActions } from './q.js';
import { gainSkill, chooseToolToCraft } from './skills.js';
import { recipeFor } from './catalog.js';
import { saveConversationToArchive } from './archive.js';
import { pickTarget, pickExploreTarget } from './scheduler.js';
import { beginSleep } from './needs.js';
import { startBuildProject } from './build.js';

export function findConversationGroup(people) {
  const available = people.filter(p =>
    p.alive !== false && !p.isAvatar && !p.conversationId && p.conversationCooldown <= 0 &&
    !p.sleeping && !p.eating && p.lifeStage !== LIFE_STAGES.BABY &&
    // a starving or exhausted person has no business chatting — survival first
    p.hunger <= GATE.STARVING && p.tiredness <= GATE.EXHAUSTED
  );
  if (available.length < 2) return null;
  for (const anchor of available) {
    const nearby = available.filter(p => p.name !== anchor.name && distBetween(anchor, p) < 4);
    if (nearby.length === 0) continue;
    const group = [anchor, ...nearby].slice(0, 4);
    return group.map(p => people.indexOf(p));
  }
  return null;
}

// Reject dialogue that won't read right: too short, or not predominantly latin
// script (some pool models occasionally drift into Chinese/other scripts). We
// don't need perfect language detection — just "is this mostly English letters".
function isUsableDialogue(text) {
  if (!text || text.length < 2) return false;
  const letters = (text.match(/[a-zA-Z]/g) || []).length;
  // any CJK / Hangul (unified ideographs, CJK symbols, Hangul) → reject outright
  const cjk = (text.match(/[\u3000-\u303f\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/g) || []).length;
  if (cjk > 0) return false;
  const alnum = (text.match(/[a-zA-Z0-9]/g) || []).length;
  return letters >= 3 && alnum / text.length > 0.4; // mostly real words
}

export async function runConversation(gameRef, participantIndices, onUpdate, signal) {
  const people = gameRef.current.people;
  const participants = participantIndices.map(i => people[i]);
  const convoId = gameRef.current.nextConvoId;
  gameRef.current = { ...gameRef.current, nextConvoId: convoId + 1 };

  for (const p of participants) {
    p.conversationId = convoId; p.activity = 'socializing';
    p.targetX = null; p.targetY = null;
    p.loneliness = clamp(p.loneliness - 10, 0, 100);
  }

  const conversation = {
    id: convoId, participants: participants.map(p => p.name),
    lines: [], location: participants[0].currentLocation,
    startTick: gameRef.current.tick, active: true,
  };
  const history = [];

  gameRef.current = { ...gameRef.current, activeConversations: [...gameRef.current.activeConversations, conversation] };
  onUpdate();

  // Everything below locks participants into the conversation. Wrap it so that if
  // anything throws (a malformed AI reply being dereferenced, etc.) we ALWAYS
  // release them — otherwise they'd keep conversationId set forever and silently
  // drop out of all future ticks (the only permanent-lock bug from AI failure).
  try {

  // target lines = 2-4 per person. We count PRODUCED lines, not attempts, so a
  // flaky model failing a turn doesn't silently burn the whole conversation.
  const targetLines = participants.length * (2 + Math.floor(Math.random() * 3));
  let lastSpeakerIdx = -1;
  const speakCount = new Map(participants.map(p => [p.name, 0]));
  // a per-speaker failure tally — someone whose model keeps failing gets skipped
  const failCount = new Map(participants.map(p => [p.name, 0]));
  let produced = 0;
  let attempts = 0;
  const maxAttempts = targetLines * 3; // generous headroom for retries

  while (produced < targetLines && attempts < maxAttempts) {
    attempts++;
    // Someone who broke off via a survival reflex sets _leftConversation. Narrate
    // their exit once; only END the conversation if fewer than 2 people remain.
    const quitter = participants.find(p => p._leftConversation === convoId);
    if (quitter) {
      conversation.lines.push({ speaker: 'narrator', text: `${quitter.name} breaks off — ${quitter.hunger > GATE.STARVING ? 'too hungry to keep talking' : 'needs to rest'}.`, thought: null, mood: null });
      quitter._leftConversation = null;
    }
    // present = still in the convo AND not hopelessly failing (3+ misses)
    const present = participants.filter(p => p.conversationId === convoId && p.alive !== false && failCount.get(p.name) < 3);
    if (present.length < 2) break;
    // Early bail: if nothing has landed yet and everyone present is already
    // failing, the AI layer is down (e.g. all models 404ing). Don't grind through
    // maxAttempts × 500ms sleeps locking these villagers in a silent stall —
    // give up now and let the cleanup release them.
    if (produced === 0 && present.every(p => failCount.get(p.name) >= 2)) break;

    let speakerIdx = pickNextSpeaker(participants, lastSpeakerIdx, speakCount, conversation.lines);
    let speaker = participants[speakerIdx];
    // pick someone present and reliable if the chosen speaker isn't usable
    if (!present.includes(speaker)) {
      speaker = present.find(p => p !== participants[lastSpeakerIdx]) || present[0];
      speakerIdx = participants.indexOf(speaker);
    }
    const others = participants.filter(p => p.name !== speaker.name);
    const cs = gameRef.current;
    const context = `${participants.length} people at ${conversation.location}. ${cs.timeOfDay}, day ${cs.day}. ${cs.weather}. ${
      conversation.lines.length === 0 ? 'They just gathered.' : ''
    }${speaker.partner ? ` ${speaker.name} is with ${speaker.partner}.` : ''}${
      speaker.hunger > 60 ? ` ${speaker.name} is hungry.` : ''}${speaker.tiredness > 60 ? ` Tired.` : ''}`;

    if (signal?.aborted) break;
    const result = await generateGroupDialogue(speaker, others, cs.people, context, history, signal);
    let dialogue = typeof result?.dialogue === 'string' ? result.dialogue.trim() : '';
    // reject garbage: empty, or not predominantly latin/English (some pool models
    // drift into other scripts). Count it as a failure for this speaker.
    if (!result || !dialogue || !isUsableDialogue(dialogue)) {
      recordModelResult(gameRef.current, speaker.model, false); // model produced garbage (#8)
      failCount.set(speaker.name, failCount.get(speaker.name) + 1);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    recordModelResult(gameRef.current, speaker.model, true);

    // cheap models love to parrot — drop a line that nearly duplicates one this
    // conversation already had. Retry (doesn't count toward produced lines).
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);
    const nd = norm(dialogue);
    if (conversation.lines.some(l => l.text && norm(l.text) === nd)) {
      if (history.length) history.pop(); // don't let the dupe poison future prompts
      failCount.set(speaker.name, failCount.get(speaker.name) + 1);
      await new Promise(r => setTimeout(r, 400));
      continue;
    }
    produced++;
    failCount.set(speaker.name, 0); // success resets their tally

    conversation.lines.push({
      speaker: speaker.name, text: dialogue, thought: result.internal_thought,
      mood: result.mood_after, addressedTo: result.addressed_to || 'everyone',
    });
    speaker.mood = result.mood_after || speaker.mood;
    speaker.thought = result.internal_thought;
    speakCount.set(speaker.name, (speakCount.get(speaker.name) || 0) + 1);
    lastSpeakerIdx = speakerIdx;

    // relationship changes — boosted familiarity
    if (result.relationship_changes) {
      for (const [name, changes] of Object.entries(result.relationship_changes)) {
        const rel = speaker.relationships[name];
        if (!rel) continue;
        // durable emotional history applies a tiny slow pressure on top of the
        // LLM's per-line deltas, without overriding them.
        const nudge = clamp(personValence(speaker, name) * 0.2, -1, 1);
        rel.affection = clamp(rel.affection + (changes.affection || 0) + nudge, 0, 100);
        rel.trust = clamp(rel.trust + (changes.trust || 0) + nudge, 0, 100);
        rel.attraction = clamp(rel.attraction + (changes.attraction || 0), 0, 100);
        rel.familiarity = clamp(rel.familiarity + 2, 0, 100); // +2 per line, not +1
      }
    }

    if (result.mood_after === 'flirty') setEmote(speaker, 'heart', 15);
    else if (result.mood_after === 'annoyed') setEmote(speaker, 'anger', 15);
    else if (result.mood_after === 'sad') setEmote(speaker, 'tear', 15);
    else if (result.mood_after === 'excited') setEmote(speaker, 'sparkle', 15);

    let convos = gameRef.current.activeConversations.map(c =>
      c.id === convoId ? { ...conversation, lines: [...conversation.lines] } : c
    );
    gameRef.current = { ...gameRef.current, activeConversations: convos };
    onUpdate();

    // ── GOSSIP BEAT (#2) ── occasionally the speaker turns to an absent third
    // party. Listeners present shift their private belief toward the speaker's
    // lean, so reputation spreads (and distorts) without direct interaction.
    if (!signal?.aborted && produced >= 2 && Math.random() < GOSSIP_CHANCE) {
      const absent = pickGossipTarget(speaker, others, cs.people);
      if (absent) {
        const g = await generateGossip(speaker, others[0], absent.name, cs, signal);
        if (g && isUsableDialogue(g.dialogue)) {
          conversation.lines.push({ speaker: speaker.name, text: g.dialogue, thought: `(about ${absent.name})`, mood: speaker.mood, addressedTo: others[0].name });
          const sign = g.lean === 'positive' ? 1 : g.lean === 'negative' ? -1 : 0;
          applyGossip(speaker, others, absent.name, sign, cs);
          convos = gameRef.current.activeConversations.map(c => c.id === convoId ? { ...conversation, lines: [...conversation.lines] } : c);
          gameRef.current = { ...gameRef.current, activeConversations: convos };
          onUpdate();
        }
      }
    }

    // ── TEACHING BEAT (#7) ── if the speaker is a flagged expert and a present
    // novice needs the lesson, run a short teaching exchange and bump their skill.
    if (!signal?.aborted && speaker._pendingTeach) {
      const student = others.find(o => o.name === speaker._pendingTeach.student);
      const skill = speaker._pendingTeach.skill;
      speaker._pendingTeach = null;
      if (student && skill) {
        const t = await generateTeaching(speaker, student, skill, signal);
        if (t && isUsableDialogue(t.dialogue)) {
          conversation.lines.push({ speaker: speaker.name, text: t.dialogue, thought: `(teaching ${student.name} about ${skill})`, mood: speaker.mood, addressedTo: student.name });
          student.skills[skill] = Math.min(100, (student.skills[skill] || 0) + 1.5);
          addMemory(student, `${speaker.name} taught me about ${skill}`, 'kindness', cs.day, { location: conversation.location });
          addMemory(speaker, `Taught ${student.name} about ${skill}`, 'achievement', cs.day, { location: conversation.location });
          bumpReputation(cs, speaker.name, 'kind', 2);
          bumpReputation(cs, speaker.name, 'skilled', 1);
          const sr = student.relationships[speaker.name];
          if (sr) { sr.affection = clamp(sr.affection + 3, 0, 100); sr.trust = clamp(sr.trust + 3, 0, 100); }
          convos = gameRef.current.activeConversations.map(c => c.id === convoId ? { ...conversation, lines: [...conversation.lines] } : c);
          gameRef.current = { ...gameRef.current, activeConversations: convos };
          onUpdate();
        }
      }
    }

    // ── RECIPE-TEACHING BEAT (Phase 5) ── an expert passes on a whole invention
    // (the knowledge, not just skill). The student LEARNS the recipe — granting
    // knownTech directly — and is moved to try it. This is how oral tradition
    // keeps a breakthrough alive across generations.
    if (!signal?.aborted && speaker._pendingTechTeach) {
      const student = others.find(o => o.name === speaker._pendingTechTeach.student);
      const techId = speaker._pendingTechTeach.techId;
      const tech = recipeFor(gameRef.current, techId);
      speaker._pendingTechTeach = null;
      if (student && tech && !student.knownTech?.[techId]) {
        const t = await generateTeaching(speaker, student, tech.label, signal);
        if (t && isUsableDialogue(t.dialogue)) {
          conversation.lines.push({ speaker: speaker.name, text: t.dialogue, thought: `(teaching ${student.name} how to make ${tech.label})`, mood: speaker.mood, addressedTo: student.name });
          student.knownTech = { ...(student.knownTech || {}), [techId]: true };
          if (tech.role && !student.techRole) student.techRole = tech.role;
          addMemory(student, `${speaker.name} taught me how to make ${tech.label}.`, 'kindness', cs.day, { location: conversation.location, valence: 2 });
          addMemory(speaker, `Passed on how to make ${tech.label} to ${student.name}.`, 'achievement', cs.day, { location: conversation.location, valence: 1.5 });
          bumpReputation(cs, speaker.name, 'kind', 2);
          bumpReputation(cs, speaker.name, 'skilled', 2);
          setEmote(student, 'sparkle', 16);
          const sr = student.relationships[speaker.name];
          if (sr) { sr.affection = clamp(sr.affection + 4, 0, 100); sr.trust = clamp(sr.trust + 4, 0, 100); }
          convos = gameRef.current.activeConversations.map(c => c.id === convoId ? { ...conversation, lines: [...conversation.lines] } : c);
          gameRef.current = { ...gameRef.current, activeConversations: convos };
          onUpdate();
        }
      }
    }

    // let people leave once there's been a real exchange (not after line 1)
    if (!result.wants_to_continue && produced >= participants.length * 2) {
      if (participants.length > 2) {
        speaker.conversationId = null;
        speaker.conversationCooldown = 10 + Math.floor(Math.random() * 10);
        speaker.activity = 'wandering';
        pickTarget(speaker, gameRef.current.people, gameRef.current);
        conversation.lines.push({ speaker: 'narrator', text: `${speaker.name} walks away.`, thought: null, mood: null });
        participants.splice(speakerIdx, 1);
        speakCount.delete(speaker.name);
        failCount.delete(speaker.name);
        conversation.participants = participants.map(p => p.name);
        if (participants.length < 2) break;
        const convos2 = gameRef.current.activeConversations.map(c =>
          c.id === convoId ? { ...conversation, lines: [...conversation.lines] } : c
        );
        gameRef.current = { ...gameRef.current, activeConversations: convos2 };
        onUpdate(); lastSpeakerIdx = -1;
      } else break;
    }

    // faster conversation pace
    await new Promise(r => setTimeout(r, 1500 / (gameRef.current.speed || 1)));
  }

  conversation.active = false;

  // store full conversation transcript into each participant's conversationLog
  const transcript = conversation.lines
    .filter(l => l.speaker !== 'narrator')
    .map(l => ({ speaker: l.speaker, text: l.text, thought: l.thought, mood: l.mood }));

  const fullRecord = {
    id: convoId,
    participants: conversation.participants.slice(),
    lines: transcript.slice(),
    day: gameRef.current.day,
    hour: gameRef.current.hour,
    minute: gameRef.current.minute,
    location: conversation.location,
    season: gameRef.current.season,
    weather: gameRef.current.weather,
    timestamp: Date.now(),
  };

  for (const p of participants) {
    p.conversationId = null;
    p.conversationCooldown = 12 + Math.floor(Math.random() * 10);
    p.activity = 'wandering';
    p.currentGoal = null;
    // storytelling grows only a LITTLE per conversation — far less than the
    // productive skills, so real work (hunting/building/foraging) defines who
    // someone becomes, not idle chatter.
    gainSkill(p, 'storytelling', 0.08);
    rewardAction(p, 'socialize', Math.max(0.5, p.loneliness / 40), gameRef.current);
    pickTarget(p, gameRef.current.people, gameRef.current);

    // store actual conversation in their personal log (capped at 20 conversations)
    if (!p.conversationLog) p.conversationLog = [];
    p.conversationLog.push({
      participants: fullRecord.participants,
      lines: transcript.slice(),
      day: fullRecord.day,
      location: fullRecord.location,
    });
    if (p.conversationLog.length > 20) p.conversationLog.shift();

    // also add a short memory summary
    const otherNames = conversation.participants.filter(n => n !== p.name).join(', ');
    const lastThing = transcript.slice(-1)[0];
    addMemory(p, `Talked with ${otherNames} at ${conversation.location}. Last thing said: "${lastThing?.text?.slice(0, 80) || '...'}"`, 'conversation', gameRef.current.day, { location: conversation.location });
  }

  // persist to global conversation archive for analysis
  saveConversationToArchive(fullRecord);

  gameRef.current.stats.totalConversations++;
  gameRef.current = {
    ...gameRef.current,
    activeConversations: gameRef.current.activeConversations.filter(c => c.id !== convoId),
    conversations: [...gameRef.current.conversations.slice(-50), conversation], // cap at 50 past convos
    events: [...gameRef.current.events.slice(-100), { day: gameRef.current.day, hour: gameRef.current.hour, participants: conversation.participants, summary: `${conversation.participants.join(', ')} chatted at ${conversation.location}`, lineCount: conversation.lines.length }],
  };
  onUpdate();
  } finally {
    // Safety net: release anyone still locked to this conversation and drop the
    // (possibly empty) active entry. On the normal path these are already done,
    // so this only fires if the body threw — preventing a permanent lock.
    let needsRelease = false;
    for (const p of participants) {
      if (p.conversationId === convoId) {
        p.conversationId = null;
        p.conversationCooldown = 12 + Math.floor(Math.random() * 10);
        p.activity = 'wandering';
        needsRelease = true;
      }
    }
    if (needsRelease) {
      gameRef.current = {
        ...gameRef.current,
        activeConversations: gameRef.current.activeConversations.filter(c => c.id !== convoId),
      };
      onUpdate();
    }
  }
}

function pickNextSpeaker(participants, lastSpeakerIdx, speakCount, lines) {
  const minCount = Math.min(...participants.map(p => speakCount.get(p.name) || 0));
  let candidates = participants.map((p, i) => ({ p, i, count: speakCount.get(p.name) || 0 }))
    .filter(c => c.i !== lastSpeakerIdx);
  const under = candidates.filter(c => c.count <= minCount);
  if (under.length > 0) candidates = under;
  if (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last.addressedTo && last.addressedTo !== 'everyone' && last.speaker !== 'narrator') {
      const addr = candidates.find(c => c.p.name.toLowerCase() === last.addressedTo.toLowerCase());
      if (addr) return addr.i;
    }
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return pick ? pick.i : (lastSpeakerIdx + 1) % participants.length;
}

export async function runAIAction(gameRef, personIdx, signal) {
  const person = gameRef.current.people[personIdx];
  // this person's LLM turn is being consumed — clear the flag and start the
  // escalation cooldown so one event doesn't spam calls.
  person.pendingLLM = false;
  person.gateCooldown = GATE.ESCALATE_COOLDOWN;
  if (person.conversationId || person.sleeping || person.eating) return;
  if (person.lifeStage === LIFE_STAGES.BABY) return;
  // only skip if cooldown AND already has a goal
  if (person.actionCooldown > 0 && person.currentGoal?.until > 0) return;

  const cs = gameRef.current;
  // who the village turns to for each role — surfaced so the LLM can choose to
  // seek the right specialist (the best healer, hunter, builder) (#5)
  const specialists = {
    healer: bestSpecialist(cs.people, 'healing', person)?.name || null,
    hunter: bestSpecialist(cs.people, 'hunting', person)?.name || null,
    builder: bestSpecialist(cs.people, 'building', person)?.name || null,
    forager: bestSpecialist(cs.people, 'foraging', person)?.name || null,
  };
  const result = await generateAction(person, cs.people, {
    timeOfDay: cs.timeOfDay, weather: cs.weather, day: cs.day,
    hour: cs.hour, minute: cs.minute,
    season: cs.season, villageFood: totalFood(cs), larder: cs.larder,
    wildlife: cs.wildlife, buildings: cs.buildings, field: cs.field,
    learned: qBestActions(person, cs, 3),       // System 5: what's been paying off
    specialty: topSkill(person),                 // specialization identity
    reputation: cs.reputation,                   // collective standing of everyone (#2)
    myReputation: reputationLabel(cs, person.name), // how the village sees you
    specialists,                                 // village go-to people by role (#5)
  }, signal);
  recordModelResult(cs, person.model, !!result); // track model reliability (#8)
  if (!result) return;

  person.mood = result.mood || person.mood;
  person.thought = result.thought || result.reason || '';
  person.actionCooldown = 10 + Math.floor(Math.random() * 5);

  // handle dynamic goal updates from AI
  if (result.update_goals && Array.isArray(result.update_goals)) {
    for (const ug of result.update_goals) {
      if (ug.action === 'add' && ug.goal) {
        if (!person.ambitions) person.ambitions = [];
        if (!person.ambitions.find(a => a.label === ug.goal)) {
          person.ambitions.push({ id: `ai_${Date.now()}`, label: ug.goal, completed: false, check: () => false });
          addMemory(person, `Set a new goal: ${ug.goal}`, 'ambition', cs.day);
        }
      } else if (ug.action === 'drop' && ug.goal) {
        if (person.ambitions) {
          const idx = person.ambitions.findIndex(a => a.label.toLowerCase().includes(ug.goal.toLowerCase()));
          if (idx >= 0) {
            addMemory(person, `Gave up on: ${person.ambitions[idx].label}`, 'ambition', cs.day);
            person.ambitions.splice(idx, 1);
          }
        }
      }
    }
  }

  const action = result.action || '';
  const target = result.target || '';

  switch (action) {
    case 'go_to':
    case 'go_to_location':
      goToLocation(person, target);
      person.activity = 'walking';
      setGoal(person, 'go_to', target, 60);
      break;

    case 'seek_person': {
      const t = cs.people.find(o => o.name.toLowerCase().includes(target.toLowerCase()) && o.alive !== false);
      if (t) { goToPerson(person, t); person.activity = 'seeking'; setGoal(person, 'seek', t.name, 50); }
      break;
    }

    case 'rest':
      beginSleep(person, 400);
      break;

    case 'gather_food':
    case 'fish':
      goToLocation(person, action === 'fish' ? 'Fishing Spot' : 'Berry Bush');
      person.activity = 'working';
      setGoal(person, 'work', null, 100);
      break;

    case 'chop_wood':
      goToLocation(person, 'Grove');
      person.activity = 'chopping';
      setGoal(person, 'chop_wood', 'Grove', 100);
      break;

    case 'collect_stone':
      goToLocation(person, 'Rock Seat');
      person.activity = 'collecting';
      setGoal(person, 'collect_stone', 'Rock Seat', 100);
      break;

    case 'gather_thatch':
      goToLocation(person, 'Meadow');
      person.activity = 'gathering';
      setGoal(person, 'gather_thatch', 'Meadow', 100);
      break;

    case 'farm':
    case 'tend_field':
    case 'harvest':
    case 'plant_crops':
      goToLocation(person, 'Field');
      person.activity = 'farming';
      setGoal(person, 'farm', 'Field', 100);
      break;

    case 'build':
      if (!person.buildProject) {
        // anyone can decide to build — not just partnered
        startBuildProject(person, cs);
      } else if (person.buildProject.phase !== 'complete') {
        person.targetX = person.buildProject.site.x;
        person.targetY = person.buildProject.site.y;
        person.activity = 'building';
        setGoal(person, 'build', null, 80);
      }
      break;

    case 'hunt': {
      // Begin the hunt — processHunting drives the per-tick chase from here,
      // re-acquiring prey via vision and pursuing its live position. We just
      // point them at the nearest visible (or named) animal to get started.
      const tooHard = (person.skills?.hunting || 0) < 8;
      let prey = nearestVisiblePrey(person, cs, { allowDangerous: !tooHard });
      if (target) {
        const named = cs.wildlife.find(w => w.alive && w.type.toLowerCase().includes(target.toLowerCase()));
        if (named) prey = named;
      }
      if (prey) {
        person.activity = 'hunting';
        person._huntTargetId = prey.id; person._huntScan = 0;
        person.targetX = prey.x; person.targetY = prey.y;
        person.thought = `On the hunt for a ${prey.type}.`;
      } else {
        // nothing in sight — go to open ground and scan (processHunting will too)
        person.thought = 'No game in sight — heading out to look.';
        goToLocation(person, 'Grove');
        person.activity = 'hunting';
        person._huntTargetId = null; person._huntScan = 0;
      }
      break;
    }

    case 'heal_person': {
      const t = cs.people.find(o => o.name.toLowerCase().includes(target.toLowerCase()) && o.sick);
      if (t) {
        goToPerson(person, t);
        person.activity = 'healing';
        setGoal(person, 'heal', t.name, 60);
      }
      break;
    }

    case 'craft': {
      // craft a tool that boosts gathering. Costs wood — gather first if short.
      if ((person.inventory.wood || 0) < 2) {
        goToLocation(person, 'Grove');
        person.activity = 'chopping';
        setGoal(person, 'work', 'Grove', 60);
        person.thought = 'Need more wood before I can make a tool.';
        break;
      }
      person.inventory.wood -= 2;
      person.craftTool = chooseToolToCraft(person);
      person.craftProgress = 0;
      person._craftDay = cs.day;
      person.activity = 'crafting';
      // craft near a workshop if one exists, else the Campfire
      const workshop = (cs.buildings || []).find(b => /workshop/i.test(b.type || ''));
      goToLocation(person, workshop ? 'Campfire' : 'Campfire');
      setGoal(person, 'craft', null, 80);
      person.thought = `Making a ${person.craftTool.replace('_', ' ')}.`;
      break;
    }

    case 'offer_shelter': {
      // a homeowner invites a specific homeless villager to shelter in their home.
      if (!person.home || !target) break;
      const guest = cs.people.find(o =>
        o.alive !== false && !o.isAvatar && o.name !== person.name &&
        o.name.toLowerCase().includes(target.toLowerCase()) && !o.home);
      if (!guest) break;
      // share the home: the guest gains it as their shelter and joins the owners
      guest.home = person.home;
      if (!person.home.owners) person.home.owners = [person.name];
      if (!person.home.owners.includes(guest.name)) person.home.owners.push(guest.name);
      // walk the guest toward the home; the host gestures warmly
      guest.targetX = person.home.x; guest.targetY = person.home.y;
      guest.currentGoal = { type: 'shelter', target: person.name, until: 80 };
      guest.activity = 'heading home';
      guest.thought = `${person.name} offered me shelter — heading to their home.`;
      setEmote(guest, 'sparkle', 24);
      setEmote(person, 'heart', 24);
      person.activity = 'welcoming';
      setGoal(person, 'social', guest.name, 30);
      // it's a kindness: memories + reputation + a relationship bump
      addMemory(person, `Offered ${guest.name} shelter in my home.`, 'kindness', cs.day, { location: person.currentLocation, valence: 1.5 });
      addMemory(guest, `${person.name} took me into their home — I won't forget it.`, 'kindness', cs.day, { location: person.currentLocation, valence: 2.5 });
      bumpReputation(cs, person.name, 'kind', 4);
      bumpReputation(cs, person.name, 'generous', 3);
      const gr = guest.relationships[person.name];
      if (gr) { gr.affection = clamp(gr.affection + 8, 0, 100); gr.trust = clamp(gr.trust + 8, 0, 100); }
      cs.events.push({ day: cs.day, hour: cs.hour, participants: [person.name, guest.name],
        summary: `🏠 ${person.name} took ${guest.name} in from the cold.`, type: 'kindness' });
      break;
    }

    case 'sit_and_think':
    case 'explore':
      if (target) goToLocation(person, target);
      else {
        // pick a random quiet spot
        const spots = ['Pond', 'Rock Seat', 'Meadow'];
        goToLocation(person, spots[Math.floor(Math.random() * spots.length)]);
      }
      person.activity = action === 'sit_and_think' ? 'thinking' : 'exploring';
      setGoal(person, action, null, 60);
      break;

    default:
      // fallback — just wander
      pickExploreTarget(person);
      person.activity = 'wandering';
      setGoal(person, 'wander', null, 40);
  }
}
