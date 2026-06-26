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

export const CHILD_NAMES = {
  male: ['Ash', 'Cedar', 'Lark', 'Reed', 'Sage', 'Wren', 'Birch', 'Flint', 'Moss', 'Clay'],
  female: ['Ivy', 'Luna', 'Fern', 'Hazel', 'Lily', 'Willa', 'Delia', 'Maeve', 'Nora', 'Thea'],
};

export const SKILLS = ['fishing', 'building', 'foraging', 'storytelling', 'healing', 'hunting', 'crafting'];

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
