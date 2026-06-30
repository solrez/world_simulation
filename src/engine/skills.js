// ── Skill progression primitive ──
// Skill grows from SUCCESS, not from time spent standing around. A productive
// yield is what teaches you — so a focused hunter/forager genuinely outpaces a
// chatterbox, and skills diverge into specialists. Shared by every cluster that
// produces a successful outcome, so it lives here as a leaf with no deps.

export const SKILL_GAIN_ON_SUCCESS = 0.15;

export function gainSkill(person, skill, amount = SKILL_GAIN_ON_SUCCESS) {
  person.skills[skill] = Math.min(100, (person.skills[skill] || 0) + amount);
}
