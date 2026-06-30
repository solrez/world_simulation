// ── Skill progression primitive ──
// Skill grows from SUCCESS, not from time spent standing around. A productive
// yield is what teaches you — so a focused hunter/forager genuinely outpaces a
// chatterbox, and skills diverge into specialists. Shared by every cluster that
// produces a successful outcome, so it lives here as a leaf with no deps.

export const SKILL_GAIN_ON_SUCCESS = 0.15;

export function gainSkill(person, skill, amount = SKILL_GAIN_ON_SUCCESS) {
  person.skills[skill] = Math.min(100, (person.skills[skill] || 0) + amount);
}

// pick the tool a person would most benefit from: matches a needed gathering
// skill they don't already have a tool for.
export function chooseToolToCraft(person) {
  const tools = person.tools || {};
  const options = [
    { tool: 'fishing_rod', skill: 'fishing' },
    { tool: 'axe', skill: 'building' },
    { tool: 'forage_basket', skill: 'foraging' },
  ].filter(o => !tools[o.tool]);
  if (!options.length) return 'fishing_rod'; // already has all; remake the first
  // favor the skill they use most (highest), so the tool pays off
  options.sort((a, b) => (person.skills[b.skill] || 0) - (person.skills[a.skill] || 0));
  return options[0].tool;
}
