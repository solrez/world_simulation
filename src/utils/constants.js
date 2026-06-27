export const TILE = 32;
export const MAP_W = 30;
export const MAP_H = 22;

export const TERRAIN = {
  GRASS: 0,
  PATH: 1,
  WATER: 2,
  FLOWERS: 3,
  DIRT: 4,
};

export const LOCATIONS = {
  CAMPFIRE: { x: 14, y: 10, name: 'Campfire', type: 'social' },
  WELL: { x: 20, y: 8, name: 'Well', type: 'resource' },
  TREE_GROVE: { x: 6, y: 5, name: 'Grove', type: 'wood' },
  POND: { x: 24, y: 15, name: 'Pond', type: 'solitude' },
  MEADOW: { x: 8, y: 16, name: 'Meadow', type: 'thatch' },
  ROCK_SEAT: { x: 18, y: 4, name: 'Rock Seat', type: 'stone' },
  BERRY_BUSH: { x: 4, y: 12, name: 'Berry Bush', type: 'food' },
  FISHING_SPOT: { x: 22, y: 14, name: 'Fishing Spot', type: 'food' },
  FIELD: { x: 12, y: 18, name: 'Field', type: 'farm' },
};

// ── Farming ──
// A multi-day crop cycle: someone sows the fallow field, it grows over several
// game-days (only in the growing seasons — frozen in winter), it must be tended,
// and once ripe it's harvested for `crops`. Q-learning lets agents discover that
// farming pays off big but slowly, and is pointless to sow in winter.
export const FARM = {
  GROW_DAYS: 4,          // game-days from sprout to ripe (with tending)
  RIPE: 1.0,             // stage at which it can be harvested
  TEND_GAIN: 0.04,       // growth added per successful tend tick (speeds ripening)
  PASSIVE_GROW_PER_DAY: 1 / 4, // baseline growth/day even untended (= 1/GROW_DAYS)
  BASE_YIELD: 6,         // crops from a harvest at skill 0
  SKILL_YIELD: 0.12,     // extra crops per point of farming skill
  // seasons in which sown crops actually grow (winter freezes progress)
  GROW_SEASONS: ['spring', 'summer', 'fall'],
};

export const BUILD_REQUIREMENTS = {
  wood: 10,
  stone: 5,
  thatch: 3,
};

export const BUILD_PHASES = ['planning', 'foundation', 'walls', 'roof', 'complete'];

export const RELATIONSHIP_STAGES = {
  STRANGER: 'stranger',
  ACQUAINTANCE: 'acquaintance',
  FRIEND: 'friend',
  CLOSE_FRIEND: 'close_friend',
  ATTRACTED: 'attracted',
  DATING: 'dating',
  PARTNERED: 'partnered',
  RIVAL: 'rival',
  ENEMY: 'enemy',
};

export const LIFE_STAGES = {
  BABY: 'baby',
  CHILD: 'child',
  TEEN: 'teen',
  ADULT: 'adult',
  ELDER: 'elder',
};

export const PERSONALITIES = [
  {
    name: 'Elara',
    gender: 'female',
    age: 22,
    color: 0xd4739a,
    traits: ['curious', 'gentle', 'observant', 'creative'],
    values: ['beauty', 'kindness', 'learning'],
    quirks: 'picks at her nails when nervous, notices small details others miss, hums off-key without realizing',
    background: 'Grew up mostly alone after her parents died young. Self-taught everything she knows. Good with her hands — weaving, arranging things. Secretly afraid of being abandoned again. Craves closeness but takes a while to trust.',
    speechStyle: 'Speaks softly, often pauses mid-sentence to think. Uses "I think" and "maybe" a lot. Asks genuine questions. Giggles when uncomfortable.',
  },
  {
    name: 'Rowan',
    gender: 'male',
    age: 25,
    color: 0x5b8cd4,
    traits: ['responsible', 'stoic', 'handy', 'stubborn'],
    values: ['reliability', 'hard work', 'protecting people'],
    quirks: 'cracks his knuckles, eats too fast, fixes things that aren\'t broken, terrible at relaxing',
    background: 'Oldest of five kids — basically raised them. Never had time to figure out what HE wants because he was always taking care of others. Doesn\'t complain but carries a lot of quiet resentment about his lost youth. Respects competence in others.',
    speechStyle: 'Blunt, few words. Says "yeah" and "right" a lot. Uncomfortable with emotional topics — changes subject or makes a dry joke. Gives practical advice nobody asked for.',
  },
  {
    name: 'Iris',
    gender: 'female',
    age: 20,
    color: 0x9ad474,
    traits: ['fierce', 'honest', 'impatient', 'warm-hearted'],
    values: ['independence', 'fairness', 'courage'],
    quirks: 'talks with her hands, interrupts people, can\'t sit still for more than a minute, stress-eats',
    background: 'Left home at 17 after fighting with controlling parents. Still carries anger about it but won\'t admit she misses them. Judges quickly but changes her mind if proven wrong. Secretly terrified of becoming like her mother. Loyal to a fault once you earn it.',
    speechStyle: 'Loud, direct, no filter. Swears occasionally. Starts sentences with "Look" or "Okay but". Argues for fun but gets genuinely upset when she thinks someone is being unfair.',
  },
  {
    name: 'Finn',
    gender: 'male',
    age: 23,
    color: 0xd4a85b,
    traits: ['funny', 'deflective', 'perceptive', 'anxious'],
    values: ['laughter', 'connection', 'meaning'],
    quirks: 'fidgets with whatever is in his hands, stays up too late, over-explains things, laughs at his own jokes',
    background: 'Used to travel alone. Tells people he chose the wandering life but truth is he was running from grief — lost someone close and never dealt with it. Uses humor to keep people at arm\'s length. Notices everything about people but pretends he doesn\'t. Wants to be known but is terrified of it.',
    speechStyle: 'Chatty, uses humor to deflect. Makes references to things he\'s seen traveling. Says "honestly" before being dishonest. Gets surprisingly real late at night or when caught off guard. Trails off mid-thought when something hits close to home.',
  },
  {
    name: 'Maren',
    gender: 'female',
    age: 58,
    color: 0xb0a0c8,
    traits: ['responsible', 'observant', 'stubborn', 'warm-hearted'],
    values: ['memory', 'continuity', 'protecting people'],
    quirks: 'rubs her aching knee before rain, tells the same stories twice, keeps count of everyone\'s birthdays, falls quiet when tired',
    background: 'The oldest in the settlement. Outlived a partner and buried more than one friend, so she carries the village\'s memory — who did what, what winters were hard, who can be trusted. Moves slower now and hates that she does. Dispenses unasked-for wisdom but is usually right. Afraid of being a burden, more afraid of being forgotten.',
    speechStyle: 'Measured, a little formal. Starts with "In my day" or "I remember when". Pauses to catch her breath. Gentle but doesn\'t suffer fools. Calls people "child" regardless of age.',
  },
  {
    name: 'Bram',
    gender: 'male',
    age: 34,
    color: 0x6a9a8a,
    traits: ['stoic', 'evasive', 'handy', 'impatient'],
    values: ['independence', 'self-reliance', 'quiet'],
    quirks: 'works with his back to people, sharpens tools that are already sharp, eats alone, answers questions with questions',
    background: 'Keeps to the edge of things. Came to the settlement years ago and never fully joined it — builds and fixes more than anyone but rarely sits at the fire. People assume he\'s cold; really he never learned how to need anyone. Guards his patch of ground and his routine fiercely. Would help you in a crisis and vanish before you could thank him.',
    speechStyle: 'Terse, flat. Long silences. Deflects personal questions. Will talk all day about how to do a thing, never about how he feels. Occasional dry, surprising kindness.',
  },
  {
    name: 'Sela',
    gender: 'female',
    age: 27,
    color: 0xe0b060,
    traits: ['curious', 'funny', 'perceptive', 'impatient'],
    values: ['connection', 'truth', 'belonging'],
    quirks: 'knows everyone\'s business, can\'t keep a secret to save her life, fills silences, remembers exactly who said what',
    background: 'The settlement\'s nerve center — she talks to everyone and carries news between them, sometimes faithfully, sometimes embroidered. Means no harm and does some anyway. Genuinely cares about people, which is why she can\'t stop discussing them. Terrified of being on the outside of things. Loyal once she trusts you, and she trusts fast.',
    speechStyle: 'Fast, warm, leading. "Did you hear—", "Don\'t tell anyone but—". Asks three questions in a row. Reads faces while she talks. Backpedals when she\'s said too much.',
  },
  {
    name: 'Tomas',
    gender: 'male',
    age: 30,
    color: 0x9a7ad4,
    traits: ['gentle', 'honest', 'responsible', 'anxious'],
    values: ['fairness', 'harmony', 'kindness'],
    quirks: 'steps between people who are arguing, apologizes preemptively, overthinks small choices, checks on the sick uninvited',
    background: 'The one who smooths things over. Hates conflict so much he\'ll wear himself thin keeping the peace between others. Has a knack for tending wounds and worries, so people come to him when they hurt. Struggles to want anything for himself — gives until there\'s nothing left, then resents it quietly. Wants to be needed, fears being used.',
    speechStyle: 'Soft, careful, diplomatic. "I just think—", "Maybe we could—". Validates before disagreeing. Goes quiet and tense when voices rise. Warmer and surer when caring for someone hurt.',
  },
];

// ── Per-agent model pool (OpenRouter) ──
// Each agent is assigned one of these at birth, so different people literally
// "think" with different models — distinct voices, not just distinct prompts.
// All are cheap, instruction-tuned, and reliably emit JSON. Routed through
// OpenRouter (one key, one endpoint). Swap freely; unknown models just fall
// back to null (reflex behavior) without breaking anything.
export const MODEL_POOL = [
  'meta-llama/llama-3.3-70b-instruct',
  'meta-llama/llama-3.1-8b-instruct',
  'mistralai/mistral-nemo',
  'mistralai/mistral-7b-instruct',
  'qwen/qwen-2.5-72b-instruct',
  'qwen/qwen-2.5-7b-instruct',
  'google/gemma-2-27b-it',
  'google/gemma-2-9b-it',
  'deepseek/deepseek-chat',
  'nousresearch/hermes-3-llama-3.1-70b',
];

export const MOODS = ['happy', 'neutral', 'sad', 'excited', 'thoughtful', 'anxious', 'flirty', 'annoyed', 'lonely', 'content', 'jealous', 'heartbroken', 'loving'];

export const MOOD_LOCATIONS = {
  sad: ['Pond', 'Rock Seat'],
  lonely: ['Campfire', 'Meadow'],
  anxious: ['Grove', 'village'],
  happy: ['Campfire', 'Meadow'],
  excited: ['Campfire', 'Well'],
  flirty: ['Meadow', 'Pond'],
  thoughtful: ['Rock Seat', 'Grove'],
  heartbroken: ['Pond', 'Rock Seat'],
  loving: ['Meadow', 'Campfire'],
};

// Emotional valence for each memory type. Positive = good memory (draws a
// person toward where it happened), negative = bad (pushes them away). Call
// sites can override with an explicit valence for type-ambiguous events.
export const MEMORY_VALENCE = {
  danger: -3,
  death: -3,
  conflict: -1.5,
  illness: -1,
  kindness: 1.5,
  achievement: 2,
  ambition: 2,
  life: 0.5,
  conversation: 0,
};

// Memory weight decays exponentially. Bad memories fade slower than good ones
// (trauma lingers), so aversions stay meaningful longer than fond pulls.
export const MEMORY_HALF_LIFE_GOOD = 4; // days
export const MEMORY_HALF_LIFE_BAD = 8; // days
// Below this decayed weight a memory is dropped entirely.
export const MEMORY_MIN_WEIGHT = 0.05;
// How sharply location valence skews the engine's own random location picks.
export const MEMORY_LOCATION_SENSITIVITY = 0.4;

// Escalation gate tunables. Reflexes (one-answer survival) are handled locally;
// "interesting" situations escalate to the LLM, which keeps all character/social
// /goal decisions. Thresholds seeded near the old needs-driven values.
export const GATE = {
  EXHAUSTED: 80,       // tiredness -> sleep reflex
  NIGHT_TIRED: 35,     // night + this tired -> sleep reflex
  STARVING: 70,        // hunger -> eat reflex (mid-hunger 40-70 is LLM territory)
  SICK_TIRED: 30,      // sick + this tired -> rest reflex
  ESCALATE_COOLDOWN: 30, // ticks to suppress re-escalation after an LLM call
  // competing-desire bands that make a situation "interesting"
  HUNGER_BAND: [40, 70],
  TIRED_BAND: [40, 80],
  LONELY_MID: 40,
  JEALOUSY_LIVE: 40,
};

// ── Aging & reproduction pacing ──
//
// ONE knob drives everything: YEARS_PER_DAY — how many life-years pass per
// game-day. Aging ties to the day rollover (so age tracks the calendar), and
// every reproductive timing below is DERIVED from it in real-life terms, so
// changing this one number keeps gestation ≈9 months, fertility ≈1 child/few
// years, etc., all automatically in proportion.
export const YEARS_PER_DAY = 1; // life-years per game-day (the master knob)

// 1 game-day = 1440 ticks (one tick = one game-minute).
export const TICKS_PER_DAY = 24 * 60;

// Real-life reproductive constants, expressed in life-YEARS, then converted to
// game-days via YEARS_PER_DAY so they scale with the master knob.
export const GESTATION_YEARS = 9 / 12;     // ~9 months
export const FERTILITY_INTERVAL_YEARS = 3; // avg life-years between conceptions per couple

// Derived game-day / per-day-chance values (used by the sim). Gestation in
// game-days: a 9-month pregnancy at 1 yr/day is 0.75 days; at 2 yr/day, 0.375.
export const GESTATION_DAYS = GESTATION_YEARS / YEARS_PER_DAY;
// Per-eligible-day conception chance s.t. expected wait ≈ FERTILITY_INTERVAL_YEARS.
// expected_days = 1/p ; expected_days = FERTILITY_INTERVAL_YEARS / YEARS_PER_DAY.
export const CONCEPTION_CHANCE = YEARS_PER_DAY / FERTILITY_INTERVAL_YEARS;

export const CHILD_NAMES = {
  male: ['Ash', 'Cedar', 'Lark', 'Reed', 'Sage', 'Wren', 'Birch', 'Flint', 'Moss', 'Clay'],
  female: ['Ivy', 'Luna', 'Fern', 'Hazel', 'Lily', 'Willa', 'Delia', 'Maeve', 'Nora', 'Thea'],
};

export const SKILLS = ['fishing', 'building', 'foraging', 'storytelling', 'healing', 'hunting', 'crafting', 'farming'];

// ── Food economy (typed food + larder + spoilage) ──
// Each food type has a hunger-restore value and a spoilage rate (fraction lost
// per game-day in the shared larder). Variety in diet gives a small mood lift.
export const FOOD_TYPES = {
  meat:    { hunger: 30, spoilPerDay: 0.25 }, // from hunting — best, but risky to get
  fish:    { hunger: 22, spoilPerDay: 0.30 }, // steady
  berries: { hunger: 14, spoilPerDay: 0.40 }, // easy, abundant in summer
  crops:   { hunger: 20, spoilPerDay: 0.10 }, // farmed — keeps longest
};

// ── Resource patches (depletion + regrowth) ──
// Foraging a patch hard reduces its yield; it recovers over days. Forces agents
// to roam and adapt instead of camping one spot forever.
export const PATCH_MIN = 0.25;        // yield multiplier never drops below this
export const PATCH_DEPLETE = 0.04;    // lost per successful harvest
export const PATCH_REGROW_PER_DAY = 0.5;

// The Grove is a patch too: chopping wood thins it (and is rendered thinner),
// and it regrows more slowly than berries — trees take time.
export const GROVE_DEPLETE = 0.03;        // lost per successful chop
export const GROVE_REGROW_PER_DAY = 0.18; // slow recovery

// ── Pond water level (rises with rain, shrinks in drought/winter) ──
// Purely numeric; the renderer reads it to grow/shrink the visible water.
export const POND_LEVEL_MAX = 1.0;
export const POND_LEVEL_MIN = 0.4;
export const POND_RAIN_GAIN = 0.06;       // per rainy/storm day
export const POND_EVAP = { spring: 0.01, summer: 0.05, fall: 0.015, winter: 0.0 }; // dry per day

// ── Chronotypes — break the uniform daily clock ──
// An agent's effective time-of-day for scheduling is shifted by this many hours
// from the world clock, so early-risers populate dawn and night-owls roam late.
export const CHRONOTYPE_OFFSET = { early: -2, normal: 0, night: 3 };
// Traits that push someone toward each chronotype (first match wins; else normal).
export const CHRONOTYPE_TRAITS = {
  night: ['restless', 'funny', 'anxious', 'deflective', 'curious'],
  early: ['responsible', 'stoic', 'handy'],
};

// ── Reputation ──
// The village's collective read on a person along a few axes (−100..100).
// Earned by visible deeds; spread (and distorted) by gossip. Each agent also
// holds private `reputationBeliefs` that gossip nudges toward the speaker's view.
export const REPUTATION_DIMS = ['generous', 'kind', 'skilled', 'reliable', 'brave'];
export const REPUTATION_DECAY_PER_DAY = 0.985; // standing slowly fades toward neutral
export const GOSSIP_PULL = 0.35;               // how far a listener's belief moves toward the gossip
export const GOSSIP_CHANCE = 0.18;             // chance a conversation turns to an absent third party

// ── Health, frailty & injury — death gets a lead-up ──
export const FRAILTY_START_AGE = 55;        // elders begin to decline
export const FRAILTY_PER_DAY = 2.5;         // frailty accrued per game-day as an elder (1 yr/day)
export const HEALTH_REGEN_PER_DAY = 4;      // baseline daily healing when not stressed
export const INJURY_HEAL_PER_DAY = 6;       // injury severity recovered per day (more with a healer)
export const HEALER_HEAL_BONUS = 10;        // extra injury recovery/day when tended by a healer
export const FRAILTY_SPEED_PENALTY = 0.4;   // max fraction of speed lost at full frailty
export const INJURY_SPEED_PENALTY = 0.5;    // max fraction of speed lost at full injury

// ── Per-model success router ──
// Track each model's recent reliability and bias new assignments toward models
// that actually return usable output. Laplace smoothing keeps it from over-
// committing on tiny samples, and a floor keeps every model occasionally tried.
export const MODEL_SMOOTHING = 4;       // pseudo-successes + pseudo-failures
export const MODEL_WEIGHT_FLOOR = 0.08; // min selection weight so nothing is fully banned

// ── Q-learning-lite ──
export const Q_ALPHA = 0.2;     // learning rate (estimate moves this fraction toward reward)
export const Q_EPSILON = 0.1;   // exploration: chance to try a non-top action

// ── Seasonal abundance multipliers for foraging/hunting yields ──
export const SEASON_ABUNDANCE = {
  spring: { forage: 1.0, hunt: 1.0 },
  summer: { forage: 1.4, hunt: 1.1 },
  fall:   { forage: 1.1, hunt: 1.2 },
  winter: { forage: 0.4, hunt: 0.7 },
};

export const WILDLIFE_TYPES = [
  { type: 'deer', speed: 0.2, fleeRange: 6, foodValue: 8, color: 0x8a6a40 },
  { type: 'rabbit', speed: 0.3, fleeRange: 4, foodValue: 3, color: 0xa09080 },
  { type: 'wolf', speed: 0.25, fleeRange: 0, foodValue: 2, color: 0x5a5a5a, dangerous: true, attackRange: 5 },
  { type: 'boar', speed: 0.15, fleeRange: 3, foodValue: 6, color: 0x6a4a30 },
  { type: 'bird', speed: 0.4, fleeRange: 8, foodValue: 1, color: 0x4080c0 },
];

export const AMBIENT_EVENTS = {
  morning: [
    'A rooster crows in the distance.',
    'Dew glistens on the grass.',
    'Birds begin their morning chorus.',
    'Mist rises from the pond.',
    'The sun paints the sky gold and pink.',
  ],
  midday: [
    'The sun beats down on the village.',
    'Crickets chirp lazily in the grass.',
    'A hawk circles overhead.',
    'The well water feels cool and refreshing.',
    'Wildflowers sway in a gentle breeze.',
  ],
  afternoon: [
    'Shadows grow longer across the paths.',
    'A gentle breeze carries the scent of berries.',
    'Butterflies dance around the meadow.',
    'The campfire crackles softly.',
  ],
  evening: [
    'Fireflies begin to glow near the pond.',
    'The sky turns shades of purple and orange.',
    'Stars begin to peek through the dusk.',
    'The campfire light grows warm and inviting.',
    'An owl hoots from the grove.',
  ],
  night: [
    'The moon casts silver light over the village.',
    'Crickets fill the silence with their song.',
    'A wolf howls somewhere far away.',
    'Embers glow softly in the campfire.',
    'The stars stretch endlessly overhead.',
  ],
  rainy: [
    'Rain patters on the leaves.',
    'Thunder rumbles in the distance.',
    'Puddles form on the dirt paths.',
    'The pond ripples under the rainfall.',
  ],
  storm: [
    'Lightning splits the sky!',
    'Wind howls through the grove.',
    'Trees bend under the fierce gale.',
    'Rain lashes down in sheets.',
  ],
};
