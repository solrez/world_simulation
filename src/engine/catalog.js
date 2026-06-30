// ── Recipe catalog access (Phase 0) ──
// The hidden TECH_GRAPH seed is cloned into a mutable per-run catalog so minted
// recipes can join it. All engine code reads recipes through here (never
// TECH_GRAPH[id] directly), so built-ins and minted recipes resolve uniformly.

import { TECH_GRAPH } from '../utils/constants.js';

// A deep-ish clone of the hidden TECH_GRAPH seed into a mutable per-run catalog.
// Recipe nodes are shallow data (no functions), so we clone fields and copy the
// array-valued ones (prereqs / matches) and the effect object defensively, so a
// runtime mutation to one run's catalog never leaks back into the constant.
export function cloneRecipeCatalog() {
  const cat = {};
  for (const [id, tech] of Object.entries(TECH_GRAPH)) {
    cat[id] = {
      ...tech,
      prereqMaterials: [...(tech.prereqMaterials || [])],
      prereqKnowledge: [...(tech.prereqKnowledge || [])],
      matches: [...(tech.matches || [])],
      effect: { ...(tech.effect || {}) },
    };
  }
  return cat;
}

// The one read path for a recipe by id. Reads the runtime catalog, falling back
// to the TECH_GRAPH seed so a half-migrated/older save (no recipeCatalog yet)
// still resolves built-in techs. All engine code goes through this, never
// TECH_GRAPH[id] directly, so minted recipes are visible everywhere.
export function recipeFor(state, id) {
  return state?.recipeCatalog?.[id] || TECH_GRAPH[id];
}

// All recipes available this run (built-ins + any minted). Used by the idea
// matcher and anything that iterates the whole graph.
export function allRecipes(state) {
  return Object.values(state?.recipeCatalog || TECH_GRAPH);
}
