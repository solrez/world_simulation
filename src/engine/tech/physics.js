// ── The physics gate (Phase 1) ──
//
// Deterministic validator standing between a structured LLM hypothesis and the
// world. The LLM proposes intent { inputs, process, ... }; this code decides
// whether it's physically allowed and, if so, how HARD it is. It reads the
// material catalog and the agent's knowledge but mutates NOTHING — pure in / out.
//
// Contract:
//   physicsGate(hypothesis, state, person) -> {
//     ok: boolean,
//     reason: string,            // why it failed (for memory flavor + tuning log)
//     normalized?: {             // present only when ok — the canonical hypothesis
//       inputs: [materialId],    // resolved, sorted, de-duped
//       process,
//       difficulty: { attemptsNeeded, failureChance },
//       key,                     // dedup key (inputs+process)
//     }
//   }
//
// The gate is deliberately a DIFFICULTY assigner, not a refuser: it only hard-
// rejects on the laws (unknown process / unknown input / conservation / prereq /
// input-count). Everything else becomes a worse roll, so the world never stalls
// on "no".

import { PROCESSES, GATE, BASE_ACCESSIBLE } from './physics.config.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Canonical key for an inputs+process combo, order-independent. Used to dedup
// rejected dead-ends and to detect "same idea, already a recipe".
export function comboKey(inputs, process) {
  return `${[...inputs].sort().join('+')}::${process}`;
}

// Resolve the agent's plain-language input names to known material ids. The LLM
// says "green rocks"; the catalog knows `copper`. We match against id, label, and
// tags, and against how THIS agent described each material they've noticed (the
// `look` text), case-insensitively. Returns { ids, unresolved }.
//
// `noticed` is the person's noticedResources map ({ [materialId]: { look } }) —
// agents naturally describe raw materials by appearance ("grey sticky earth"),
// not by catalog tags, so their own discovery text is the strongest hint.
export function resolveInputs(rawInputs, materialCatalog, noticed) {
  const cat = Object.values(materialCatalog || {});
  const ids = [];
  const unresolved = [];
  // whole-word containment: `needle` appears in `t` only as its own word, so
  // "moonstone" does NOT match `stone` but "the grey stone" does.
  const hasWord = (t, needle) => {
    if (!needle) return false;
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${esc}\\b`).test(t);
  };
  // Overlap of meaningful words between the agent's phrase and a `look` string —
  // "grey sticky earth" vs "a band of grey, sticky earth at the water's edge".
  const STOP = new Set(['the', 'a', 'an', 'of', 'at', 'and', 'that', 'with', 'some', 'it', 'in', 'to']);
  const words = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2 && !STOP.has(w)));
  const lookMatch = (t) => {
    let best = null, bestN = 1; // need at least 2 shared content words
    for (const [mat, info] of Object.entries(noticed || {})) {
      const a = words(t), b = words(info?.look);
      let n = 0; for (const w of a) if (b.has(w)) n++;
      if (n > bestN) { bestN = n; best = mat; }
    }
    return best;
  };
  for (const raw of rawInputs || []) {
    const t = String(raw || '').toLowerCase().trim();
    if (!t) continue;
    // exact id / label hit first
    let id = cat.find(m => m.id === t || (m.label || '').toLowerCase() === t)?.id;
    // else the id or label appears as a WHOLE WORD in the phrase
    if (!id) id = cat.find(m => hasWord(t, m.id) || hasWord(t, (m.label || '').toLowerCase()))?.id;
    // else how the agent described a material they noticed ("grey sticky earth")
    if (!id) id = lookMatch(t);
    // else a tag the agent might describe by ("the sharp stones" -> tag 'sharp')
    if (!id) id = cat.find(m => (m.tags || []).some(tag => hasWord(t, tag)))?.id;
    if (id) { if (!ids.includes(id)) ids.push(id); }
    else unresolved.push(raw);
  }
  return { ids, unresolved };
}

// Estimate difficulty from input rarity/energy + process complexity. Pure: same
// inputs+process always yield the same numbers, so a re-discovered recipe is
// consistent. Stronger (rarer/costlier/more complex) combos are harder, capped.
function estimateDifficulty(inputIds, process, materialCatalog) {
  const proc = PROCESSES[process];
  const mats = inputIds.map(id => materialCatalog[id]).filter(Boolean);
  const avgRarity = mats.length ? mats.reduce((s, m) => s + (m.rarity ?? 0.3), 0) / mats.length : 0.3;
  const avgEnergy = mats.length ? mats.reduce((s, m) => s + (m.energyCost ?? 1), 0) / mats.length : 1;
  const complexity = proc?.complexity ?? 0.4;

  // failure rises with rarity, complexity, and a touch of input count (juggling
  // more things is harder). Stays within [MIN_FAIL, MAX_FAIL].
  const failRaw = GATE.BASE_FAIL + avgRarity * 0.3 + complexity * 0.3 + (inputIds.length - 1) * 0.04;
  const failureChance = clamp(failRaw, GATE.MIN_FAIL, GATE.MAX_FAIL);

  // attempts scale with energy cost + complexity, rounded into the authored range.
  const attemptsRaw = GATE.BASE_ATTEMPTS + avgEnergy * 0.6 + complexity * 2;
  const attemptsNeeded = clamp(Math.round(attemptsRaw), GATE.BASE_ATTEMPTS, GATE.MAX_ATTEMPTS);

  return { attemptsNeeded, failureChance };
}

// The gate. See contract at top of file.
export function physicsGate(hypothesis, state, person) {
  const materialCatalog = state?.materialCatalog || {};
  const process = String(hypothesis?.process || '').toLowerCase().trim();

  // — law 1: process must be on the whitelist —
  const proc = PROCESSES[process];
  if (!proc) return { ok: false, reason: `unknown process "${hypothesis?.process || '∅'}"` };

  // — resolve inputs to known materials (agent's own discovery text included) —
  const { ids, unresolved } = resolveInputs(hypothesis?.inputs, materialCatalog, person?.noticedResources);

  // — law 2: input count within primitive bounds —
  if (ids.length < GATE.MIN_INPUTS) {
    return { ok: false, reason: unresolved.length ? `unknown material(s): ${unresolved.join(', ')}` : 'no usable materials named' };
  }
  if (ids.length > GATE.MAX_INPUTS) {
    return { ok: false, reason: `too many materials at once (${ids.length})` };
  }
  // an idea naming a mystery material can't be conserved — reject (can't mass it)
  if (unresolved.length) {
    return { ok: false, reason: `unknown material(s): ${unresolved.join(', ')}` };
  }

  // — law 3: the agent must be able to perform the process —
  if (proc.enabler && !(person?.knownTech?.[proc.enabler] || state?.knownTech?.[proc.enabler])) {
    return { ok: false, reason: `can't ${process} yet — needs ${proc.enabler}` };
  }

  // — law 4: the agent must have access to every input (owned, noticed, or a
  // freely-gatherable base material like wood/stone/thatch) —
  const missing = ids.filter(id =>
    !(BASE_ACCESSIBLE.has(id) || (person?.inventory?.[id] || 0) > 0 || person?.noticedResources?.[id]));
  if (missing.length) {
    return { ok: false, reason: `doesn't have ${missing.join(', ')}` };
  }

  // — law 5: conservation. Output is a single unit; its mass can't exceed the
  // input mass (+ slack). We don't know the output material yet (that's Phase 2),
  // but the BOUND is checkable now: total input mass must be ≥ ~1 unit of stuff. —
  const inMass = ids.reduce((s, id) => s + (materialCatalog[id]?.mass ?? 1), 0);
  if (inMass + GATE.MASS_SLACK < 1) {
    return { ok: false, reason: 'not enough material to make anything lasting' };
  }

  const difficulty = estimateDifficulty(ids, process, materialCatalog);
  const sorted = [...ids].sort();
  return {
    ok: true,
    reason: 'ok',
    normalized: { inputs: sorted, process, difficulty, key: comboKey(sorted, process) },
  };
}
